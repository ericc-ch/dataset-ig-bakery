import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Duration, Effect, FileSystem, Path } from "effect"
import { pathToFileURL } from "node:url"
import { chromium, type BrowserContext, type Page } from "playwright"
import which from "which"

const config = {
  instagramProfileUrl: "https://www.instagram.com/hollandbakeryindonesia/",
  postLimit: 50,
  maxProfileScrolls: 200,
  maxScrollsWithoutNewPosts: 3,
  dataDirectory: "data",
  imagesDirectoryName: "images",
  browserProfileDirectory: "../.browser-profile/",
  browserExecutable: "helium",
  browserHeadless: false,
  profileScrollDelayMs: 1_200,
  profileScrollJitterMs: 1_000,
  postLoadDelayMs: 800,
  postLoadJitterMs: 700,
  betweenPostsDelayMs: 1_500,
  betweenPostsJitterMs: 1_500,
} as const

const profileUrl = config.instagramProfileUrl
const profileUsername = new URL(profileUrl).pathname.split("/").find(Boolean)
if (profileUsername === undefined) {
  throw new Error(`Instagram profile URL must include a username: ${profileUrl}`)
}
const dataDirectory = config.dataDirectory
const imagesDirectory = `${dataDirectory}/${config.imagesDirectoryName}`
const datasetPath = `${dataDirectory}/dataset.json`

type ImageAsset = {
  index: number
  sourceUrl: string
  width: number | null
  height: number | null
}

type SavedImageAsset = Omit<ImageAsset, "sourceUrl"> & {
  localPath: string
}

type PostSample = {
  url: string
  timestamp: string | null
  likeCount: number | string | null
  commentCount: number | string | null
  caption: string
  images: Array<ImageAsset>
}

type SavedPostSample = Omit<PostSample, "images"> & {
  images: Array<SavedImageAsset>
}

const sleepWithJitter = Effect.fn("sleepWithJitter")(function* (baseMs: number, jitterMs: number) {
  yield* Effect.sleep(Duration.millis(baseMs + Math.floor(Math.random() * jitterMs)))
})

const sanitizeFilenamePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-")

const postShortcodeFromUrl = (url: string) => url.match(/\/p\/([^/]+)/)?.[1] ?? url

const normalizePostUrl = (url: string) => {
  const parsed = new URL(url)
  const shortcode = postShortcodeFromUrl(parsed.pathname)
  return `https://www.instagram.com/p/${shortcode}/`
}

const readExistingDataset = Effect.fn("readExistingDataset")(function* () {
  const fs = yield* FileSystem.FileSystem

  const exists = yield* fs.exists(datasetPath)
  if (!exists) {
    return [] as Array<SavedPostSample>
  }

  const content = yield* fs.readFileString(datasetPath)
  const parsed = JSON.parse(content) as Array<
    Omit<SavedPostSample, "images"> & {
      shortcode?: string
      images: Array<SavedImageAsset & { url?: string }>
    }
  >

  return parsed.map((sample) => ({
    url: normalizePostUrl(sample.url),
    timestamp: sample.timestamp,
    likeCount: sample.likeCount,
    commentCount: sample.commentCount,
    caption: sample.caption,
    images: sample.images.map(({ url: _url, index, width, height, localPath }) => ({
      index,
      width,
      height,
      localPath,
    })),
  }))
})

const collectPostUrls = Effect.fn("collectPostUrls")(function* (
  page: Page,
  existingUrls: ReadonlySet<string>,
) {
  yield* Effect.promise(() => page.goto(profileUrl, { waitUntil: "domcontentloaded" }))
  yield* Effect.promise(() => page.waitForLoadState("domcontentloaded"))

  const urls = new Set<string>()
  let stableScrolls = 0
  let lastSize = 0

  for (
    let index = 0;
    index < config.maxProfileScrolls && urls.size < config.postLimit;
    index += 1
  ) {
    const visibleUrls = yield* Effect.promise(() =>
      page.evaluate(() => {
        const isPinnedPost = (anchor: HTMLAnchorElement) => {
          const pinnedSelector = [
            'svg[aria-label*="Pinned"]',
            'svg[aria-label*="pinned"]',
            'svg[title*="Pinned"]',
            'svg[title*="pinned"]',
            '[aria-label*="Pinned post"]',
            '[aria-label*="pinned post"]',
          ].join(", ")

          let element: Element | null = anchor
          for (let depth = 0; depth < 3 && element !== null; depth += 1) {
            if (element.querySelector(pinnedSelector) !== null) {
              return true
            }
            element = element.parentElement
          }

          return false
        }

        return Array.from(
          new Set(
            Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"]'))
              .filter((anchor) => !isPinnedPost(anchor))
              .map((anchor) => anchor.href),
          ),
        )
      }),
    )

    for (const url of visibleUrls) {
      const normalizedUrl = normalizePostUrl(url)
      if (!existingUrls.has(normalizedUrl)) {
        urls.add(normalizedUrl)
      }
    }

    stableScrolls = urls.size === lastSize ? stableScrolls + 1 : 0
    lastSize = urls.size

    yield* Console.log(`Seen ${urls.size} new post URLs after scroll ${index + 1}`)

    if (stableScrolls >= config.maxScrollsWithoutNewPosts) {
      break
    }

    yield* Effect.promise(() =>
      page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)),
    )
    yield* sleepWithJitter(config.profileScrollDelayMs, config.profileScrollJitterMs)
  }

  return Array.from(urls).slice(0, config.postLimit)
})

const extractPost = Effect.fn("extractPost")(function* (context: BrowserContext, url: string) {
  return yield* Effect.acquireUseRelease(
    Effect.promise(() => context.newPage()),
    (page) =>
      Effect.promise(async () => {
        const shortcode = postShortcodeFromUrl(url)

        await page.goto(url, { waitUntil: "domcontentloaded" })
        await page.waitForLoadState("domcontentloaded")
        await page.waitForTimeout(
          config.postLoadDelayMs + Math.floor(Math.random() * config.postLoadJitterMs),
        )

        return page.evaluate<PostSample, string>((currentShortcode) => {
          const findMediaItem = (
            value: unknown,
            targetShortcode: string,
          ): Record<string, unknown> | null => {
            if (value === null || typeof value !== "object") {
              return null
            }

            if (Array.isArray(value)) {
              for (const item of value) {
                const found = findMediaItem(item, targetShortcode)
                if (found !== null) {
                  return found
                }
              }
              return null
            }

            const record = value as Record<string, unknown>
            if (
              record["code"] === targetShortcode &&
              (record["like_count"] !== undefined ||
                record["comment_count"] !== undefined ||
                record["taken_at"] !== undefined)
            ) {
              return record
            }

            const webInfo = record["xdt_api__v1__media__shortcode__web_info"] as
              | Record<string, unknown>
              | undefined
            const items = webInfo?.["items"] ?? record["items"]
            if (Array.isArray(items)) {
              const direct = items.find(
                (item) =>
                  item !== null &&
                  typeof item === "object" &&
                  (item as Record<string, unknown>)["code"] === targetShortcode,
              )
              if (direct !== undefined && typeof direct === "object" && direct !== null) {
                return direct as Record<string, unknown>
              }
            }

            for (const item of Object.values(record)) {
              const found = findMediaItem(item, targetShortcode)
              if (found !== null) {
                return found
              }
            }

            return null
          }

          const bestImage = (media: Record<string, unknown>) => {
            const imageVersions = media["image_versions2"] as Record<string, unknown> | undefined
            const candidates = imageVersions?.["candidates"]

            if (!Array.isArray(candidates)) {
              return null
            }

            return candidates
              .filter((candidate): candidate is Record<string, unknown> => {
                if (candidate === null || typeof candidate !== "object") {
                  return false
                }

                const record = candidate as Record<string, unknown>
                return (
                  typeof record["url"] === "string" &&
                  typeof record["width"] === "number" &&
                  typeof record["height"] === "number"
                )
              })
              .sort(
                (a, b) =>
                  (b["width"] as number) * (b["height"] as number) -
                  (a["width"] as number) * (a["height"] as number),
              )[0]
          }

          let media: Record<string, unknown> | null = null
          for (const script of Array.from(document.scripts)) {
            const text = script.textContent ?? ""
            if (!text.includes(currentShortcode)) {
              continue
            }

            try {
              media = findMediaItem(JSON.parse(text), currentShortcode)
              if (media !== null) {
                break
              }
            } catch {
              // Instagram stores useful payloads in JSON script tags, but not every script is JSON.
            }
          }

          const metaDescription =
            document.querySelector<HTMLMetaElement>(
              'meta[property="og:description"], meta[name="description"]',
            )?.content ?? ""
          const metaTitle =
            document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? ""
          const metaImage =
            document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? ""
          const metaCounts = metaDescription.match(/^([\d,.KkMm]+) likes?, ([\d,.KkMm]+) comments?/)
          const metaCaption =
            metaDescription.match(/: "([\s\S]*)"\.\s*$/)?.[1] ??
            metaTitle.match(/Instagram: "([\s\S]*)"$/)?.[1] ??
            ""

          const carouselMedia = media?.["carousel_media"]
          const mediaItems = Array.isArray(carouselMedia)
            ? carouselMedia.filter(
                (item): item is Record<string, unknown> =>
                  item !== null && typeof item === "object",
              )
            : media === null
              ? []
              : [media]

          const images = mediaItems
            .filter((item) => item["media_type"] !== 2)
            .map((item, index): ImageAsset | null => {
              const image = bestImage(item)
              if (image === undefined || image === null) {
                return null
              }

              return {
                index,
                sourceUrl: image["url"] as string,
                width: image["width"] as number,
                height: image["height"] as number,
              }
            })
            .filter((image): image is ImageAsset => image !== null)

          const timestamp =
            typeof media?.["taken_at"] === "number"
              ? new Date(media["taken_at"] * 1_000).toISOString()
              : (document.querySelector<HTMLTimeElement>("time")?.dateTime ?? null)
          const caption = media?.["caption"] as Record<string, unknown> | undefined

          return {
            url: location.href,
            timestamp,
            likeCount:
              typeof media?.["like_count"] === "number"
                ? media["like_count"]
                : (metaCounts?.[1] ?? null),
            commentCount:
              typeof media?.["comment_count"] === "number"
                ? media["comment_count"]
                : (metaCounts?.[2] ?? null),
            caption:
              typeof caption?.["text"] === "string"
                ? caption["text"]
                : typeof media?.["caption_text"] === "string"
                  ? media["caption_text"]
                  : metaCaption,
            images:
              images.length > 0
                ? images
                : metaImage === ""
                  ? []
                  : [{ index: 0, sourceUrl: metaImage, width: null, height: null }],
          }
        }, shortcode)
      }),
    (page) => Effect.promise(() => page.close()),
  )
})

const downloadImage = Effect.fn("downloadImage")(function* (image: ImageAsset, post: PostSample) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const shortcode = postShortcodeFromUrl(post.url)
  const filename = [
    sanitizeFilenamePart(profileUsername),
    sanitizeFilenamePart(shortcode),
    image.index,
  ].join("-")
  const localPath = path.join(imagesDirectory, `${filename}.jpg`)

  const data = yield* Effect.promise(async () => {
    const response = await fetch(image.sourceUrl)
    if (!response.ok) {
      throw new Error(
        `Failed to download ${image.sourceUrl}: ${response.status} ${response.statusText}`,
      )
    }

    return new Uint8Array(await response.arrayBuffer())
  })
  yield* fs.writeFile(localPath, data)

  return {
    index: image.index,
    width: image.width,
    height: image.height,
    localPath,
  }
})

const saveDataset = Effect.fn("saveDataset")(function* (
  existingSamples: Array<SavedPostSample>,
  newSamples: Array<PostSample>,
) {
  const fs = yield* FileSystem.FileSystem

  yield* fs.makeDirectory(imagesDirectory, { recursive: true })

  const newSamplesWithLocalImages: Array<SavedPostSample> = []
  for (const sample of newSamples) {
    const images: Array<SavedImageAsset> = []
    for (const image of sample.images) {
      images.push(yield* downloadImage(image, sample))
    }

    newSamplesWithLocalImages.push({
      ...sample,
      url: normalizePostUrl(sample.url),
      images,
    })
  }

  const samples = [...newSamplesWithLocalImages, ...existingSamples]

  yield* fs.writeFileString(datasetPath, JSON.stringify(samples, null, 2))
  return samples
})

const main = Effect.fn("main")(function* () {
  const profilePath = new URL(config.browserProfileDirectory, import.meta.url)
  const executablePath = yield* Effect.promise(() => which(config.browserExecutable))
  const existingSamples = yield* readExistingDataset()
  const existingUrls = new Set(existingSamples.map((sample) => sample.url))

  yield* Console.log(`Loaded ${existingUrls.size} existing posts from ${datasetPath}`)

  const context = yield* Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launchPersistentContext(profilePath.pathname, {
        executablePath,
        headless: config.browserHeadless,
      }),
    ),
    (context) => Effect.promise(() => context.close()),
  )

  const postUrls = yield* Effect.acquireUseRelease(
    Effect.promise(() => context.newPage()),
    (page) => collectPostUrls(page, existingUrls),
    (page) => Effect.promise(() => page.close()),
  )

  yield* Console.log(`Collecting details for ${postUrls.length} posts`)

  const samples: Array<PostSample> = []
  for (const postUrl of postUrls) {
    const sample = yield* extractPost(context, postUrl)
    samples.push(sample)

    yield* Console.log(
      `Collected ${postShortcodeFromUrl(sample.url)}: ${sample.likeCount} likes, ${sample.commentCount} comments`,
    )
    yield* sleepWithJitter(config.betweenPostsDelayMs, config.betweenPostsJitterMs)
  }

  const savedSamples = yield* saveDataset(existingSamples, samples)

  yield* Console.log(`Saved ${savedSamples.length} posts to ${datasetPath}`)
})

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  NodeRuntime.runMain(Effect.scoped(main()).pipe(Effect.provide(NodeServices.layer)))
}
