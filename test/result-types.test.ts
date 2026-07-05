import { describe, it, expectTypeOf } from "vitest";
import { schema } from "../examples/blog/schema.js";
import type { InferWithResult } from "../src/schema/relation-types.js";

type UserRow = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

type PostRow = {
  id: string;
  title: string;
  body: string;
  published: boolean;
  authorId: string;
  views: number;
  status: string;
  price: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type Expect<T extends true> = T;

describe("select return types", () => {
  it("narrows relation select fields", () => {
    type Result = InferWithResult<
      typeof schema._tables,
      "users",
      { posts: { select: { title: true } } },
      UserRow
    >;

    type _Check = Expect<
      Result extends { posts?: Array<{ title: string }> } ? true : false
    >;
    const _assert: _Check = true;
    void _assert;
  });

  it("includes _count when requested", () => {
    type Result = InferWithResult<
      typeof schema._tables,
      "users",
      { _count: { posts: true } },
      UserRow
    >;

    type _Check = Expect<Result extends { _count?: { posts: number } } ? true : false>;
    const _assert: _Check = true;
    void _assert;
  });

  it("keeps full row when with is undefined", () => {
    type Result = InferWithResult<typeof schema._tables, "users", undefined, UserRow>;
    expectTypeOf<Result>().toEqualTypeOf<UserRow>();
  });

  it("narrows nested relation select on posts", () => {
    type Result = InferWithResult<
      typeof schema._tables,
      "posts",
      { author: { select: { email: true } } },
      PostRow
    >;

    type _Check = Expect<
      Result extends { author?: { email: string } | null } ? true : false
    >;
    const _assert: _Check = true;
    void _assert;
  });
});
