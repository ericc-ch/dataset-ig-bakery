#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

type ImageAsset = {
  readonly index: number
  readonly width: number | null
  readonly height: number | null
  readonly localPath: string
}

type PostSample = {
  readonly url: string
  readonly timestamp: string | null
  readonly likeCount: number | string | null
  readonly commentCount: number | string | null
  readonly caption: string
  readonly images: ReadonlyArray<ImageAsset>
}

type RepositoryMetadata = {
  readonly nameWithOwner: string
  readonly defaultBranchRef?: {
    readonly name?: string
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(scriptDir)
const datasetPath = "data/dataset.json"
const outputPath = process.argv[2] ?? "data/dataset.csv"

const getRepositoryMetadata = () => {
  const output = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], {
    cwd: projectRoot,
    encoding: "utf8",
  })

  return JSON.parse(output) as RepositoryMetadata
}

const csvValue = (value: string | number | null) => {
  if (value === null) {
    return ""
  }

  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const csvRow = (values: ReadonlyArray<string | number | null>) => values.map(csvValue).join(",")

const rawGithubUrl = (nameWithOwner: string, branch: string, localPath: string) => {
  const normalizedPath = (
    isAbsolute(localPath) ? relative(projectRoot, localPath) : localPath
  ).replaceAll("\\", "/")

  return `https://raw.githubusercontent.com/${nameWithOwner}/${branch}/${encodeURI(normalizedPath)}`
}

const imageFormula = (url: string) => `=IMAGE("${url}")`

const repository = getRepositoryMetadata()
const branch = repository.defaultBranchRef?.name ?? "main"
const dataset = JSON.parse(
  readFileSync(`${projectRoot}/${datasetPath}`, "utf8"),
) as ReadonlyArray<PostSample>

const headers = [
  "url",
  "timestamp",
  "likeCount",
  "commentCount",
  "caption",
  "imageCount",
  "firstImageUrl",
  "firstImageFormula",
  "imageUrls",
  "imageFormulas",
  "imageDimensions",
]

const rows = dataset.map((post) => {
  const imageUrls = post.images.map((image) =>
    rawGithubUrl(repository.nameWithOwner, branch, image.localPath),
  )
  const imageFormulas = imageUrls.map(imageFormula)
  const imageDimensions = post.images.map((image) => `${image.width ?? ""}x${image.height ?? ""}`)

  return csvRow([
    post.url,
    post.timestamp,
    post.likeCount,
    post.commentCount,
    post.caption,
    post.images.length,
    imageUrls[0] ?? "",
    imageFormulas[0] ?? "",
    imageUrls.join(" | "),
    imageFormulas.join(" | "),
    imageDimensions.join(" | "),
  ])
})

mkdirSync(dirname(`${projectRoot}/${outputPath}`), { recursive: true })
writeFileSync(`${projectRoot}/${outputPath}`, [csvRow(headers), ...rows].join("\n"))

console.log(`Exported ${dataset.length} rows to ${outputPath}`)
console.log(`Image URLs use ${repository.nameWithOwner}@${branch}`)
