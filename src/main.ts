import { NodeRuntime } from "@effect/platform-node"
import { Console, Duration, Effect } from "effect"
import { pathToFileURL } from "node:url"
import { chromium, type BrowserContext, type Page } from "playwright"
import which from "which"

export const one = 1
export const two = 2
export const add = (a: number, b: number) => a + b

const profileUrl = "https://www.instagram.com/hollandbakeryindonesia/"
const postLimit = 5
const maxScrolls = 20

type ImageAsset = {
  index: number
  type: "image" | "video_thumbnail"
  url: string
  width: number | null
  height: number | null
}

type PostSample = {
  url: string
  shortcode: string
  productType: string | null
  mediaType: number | null
  timestamp: string | null
  likeCount: number | string | null
  commentCount: number | string | null
  playCount: number | null
  viewCount: number | null
  caption: string
  imageCount: number
  images: Array<ImageAsset>
}

const sleepWithJitter = (baseMs: number, jitterMs: number) =>
  Effect.sleep(Duration.millis(baseMs + Math.floor(Math.random() * jitterMs)))

const collectPostUrls = (page: Page) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.goto(profileUrl, { waitUntil: "domcontentloaded" }))
    yield* Effect.promise(() => page.waitForLoadState("domcontentloaded"))

    const urls = new Set<string>()
    let stableScrolls = 0
    let lastSize = 0

    for (let index = 0; index < maxScrolls && urls.size < postLimit; index += 1) {
      const visibleUrls = yield* Effect.promise(() =>
        page.evaluate(() =>
          Array.from(
            new Set(
              Array.from(
                document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]'),
              ).map((anchor) => anchor.href),
            ),
          ),
        ),
      )

      for (const url of visibleUrls) {
        urls.add(url)
      }

      stableScrolls = urls.size === lastSize ? stableScrolls + 1 : 0
      lastSize = urls.size

      yield* Console.log(`Seen ${urls.size} post URLs after scroll ${index + 1}`)

      if (stableScrolls >= 3) {
        break
      }

      yield* Effect.promise(() =>
        page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)),
      )
      yield* sleepWithJitter(1_200, 1_000)
    }

    return Array.from(urls).slice(0, postLimit)
  })

const extractPost = (context: BrowserContext, url: string) =>
  Effect.acquireUseRelease(
    Effect.promise(() => context.newPage()),
    (page) =>
      Effect.promise(async () => {
        const shortcode = url.match(/\/(?:p|reel)\/([^/]+)/)?.[1] ?? url

        await page.goto(url, { waitUntil: "domcontentloaded" })
        await page.waitForLoadState("domcontentloaded")
        await page.waitForTimeout(800 + Math.floor(Math.random() * 700))

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
            .map((item, index): ImageAsset | null => {
              const image = bestImage(item)
              if (image === undefined || image === null) {
                return null
              }

              return {
                index,
                type: item["media_type"] === 2 ? "video_thumbnail" : "image",
                url: image["url"] as string,
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
            shortcode: currentShortcode,
            productType: typeof media?.["product_type"] === "string" ? media["product_type"] : null,
            mediaType: typeof media?.["media_type"] === "number" ? media["media_type"] : null,
            timestamp,
            likeCount:
              typeof media?.["like_count"] === "number"
                ? media["like_count"]
                : (metaCounts?.[1] ?? null),
            commentCount:
              typeof media?.["comment_count"] === "number"
                ? media["comment_count"]
                : (metaCounts?.[2] ?? null),
            playCount: typeof media?.["play_count"] === "number" ? media["play_count"] : null,
            viewCount: typeof media?.["view_count"] === "number" ? media["view_count"] : null,
            caption:
              typeof caption?.["text"] === "string"
                ? caption["text"]
                : typeof media?.["caption_text"] === "string"
                  ? media["caption_text"]
                  : metaCaption,
            imageCount: images.length || (metaImage === "" ? 0 : 1),
            images:
              images.length > 0
                ? images
                : metaImage === ""
                  ? []
                  : [{ index: 0, type: "image", url: metaImage, width: null, height: null }],
          }
        }, shortcode)
      }),
    (page) => Effect.promise(() => page.close()),
  )

const main = Effect.gen(function* () {
  const profilePath = new URL("../.browser-profile/", import.meta.url)
  const executablePath = yield* Effect.promise(() => which("helium"))

  const context = yield* Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launchPersistentContext(profilePath.pathname, {
        executablePath,
        headless: false,
      }),
    ),
    (context) => Effect.promise(() => context.close()),
  )

  const page = yield* Effect.promise(() => context.newPage())
  const postUrls = yield* collectPostUrls(page)

  yield* Console.log(`Collecting details for ${postUrls.length} posts`)

  const samples: Array<PostSample> = []
  for (const postUrl of postUrls) {
    const sample = yield* extractPost(context, postUrl)
    samples.push(sample)

    yield* Console.log(
      `Collected ${sample.shortcode}: ${sample.likeCount} likes, ${sample.commentCount} comments`,
    )
    yield* sleepWithJitter(1_500, 1_500)
  }

  yield* Console.log(JSON.stringify(samples, null, 2))
})

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  NodeRuntime.runMain(Effect.scoped(main))
}
