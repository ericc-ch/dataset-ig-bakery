import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { add, one, two } from "./main.ts"

describe("main", () => {
  it("exports one", () => {
    deepStrictEqual(one, 1)
  })

  it("exports two", () => {
    deepStrictEqual(two, 2)
  })

  it("add function works", () => {
    deepStrictEqual(add(1, 2), 3)
  })
})
