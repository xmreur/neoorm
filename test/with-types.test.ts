import { describe, it, expect, expectTypeOf } from "vitest";
import type { schema } from "../examples/blog/schema.js";
import type { WithInputMap, RelationAccessors } from "../src/schema/relation-types.js";

type Schema = typeof schema._tables;

describe("with autocomplete types", () => {
  it("infers post relations", () => {
    expectTypeOf<RelationAccessors<Schema, "posts">>().toMatchTypeOf<{
      author?: "users";
      comments?: "comments";
      tags?: "tags";
    }>();
  });

  it("infers user relations", () => {
    expectTypeOf<RelationAccessors<Schema, "users">>().toMatchTypeOf<{
      profile?: "profiles";
      posts?: "posts";
      comments?: "comments";
    }>();
  });

  it("types nested with on posts", () => {
    type PostsWith = WithInputMap<Schema, "posts">;
    expectTypeOf<PostsWith>().toMatchTypeOf<{
      author?: boolean | { select?: readonly ("id" | "email" | "name")[] };
      comments?: boolean;
      tags?: boolean;
    }>();

    type ValidWith = {
      author: {
        select: ["id", "email", "name"],
        with: {
          profile: true,
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        with: {
          author: { select: ["id", "name"] },
        },
      },
      tags: true,
    };
    expectTypeOf<ValidWith>().toExtend<PostsWith>();
  });

  it("types findById with option", () => {
    type UsersFindById = import("../src/schema/types.js").FindByIdArgs<Schema, "users">;
    type ValidFindById = {
      with: {
        profile: true,
        posts: { orderBy: { createdAt: "desc" } },
      },
    };
    expectTypeOf<ValidFindById>().toExtend<UsersFindById>();
  });

  it("types select object and orderBy columns", () => {
    type PostsWith = WithInputMap<Schema, "posts">;
    type ValidWith = {
      author: {
        select: { id: true, email: true, name: true },
        with: {
          profile: true,
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        with: {
          author: { select: { id: true, name: true } },
        },
      },
      tags: true,
    };
    expectTypeOf<ValidWith>().toExtend<PostsWith>();
  });

  it("requires all relation keys on with map for autocomplete", () => {
    type UsersWith = WithInputMap<Schema, "users">;
    type Keys = keyof UsersWith;
    type AssertKeys = Keys extends "profile" | "posts" | "comments" | "postTags"
      ? true
      : false;
    const assert: AssertKeys = true;
    expect(assert).toBe(true);
  });
});
