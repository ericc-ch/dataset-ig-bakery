import { chromium } from "playwright"
import which from "which"

const profilePath = new URL("../.browser-profile/", import.meta.url)
const executablePath = await which("helium")

const context = await chromium.launchPersistentContext(profilePath.pathname, {
  executablePath,
  headless: false,
})

const page = await context.newPage()
await page.goto("https://google.com")
