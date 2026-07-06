import { describe, expect, expectTypeOf, it } from "vitest";
import type { PostsWith } from "../examples/blog/neoorm/includes.js";
import type { schema } from "../examples/blog/schema.js";
import type { WhereInput } from "../src/schema/relation-types.js";

type Schema = typeof schema._tables;

describe("with autocomplete types", () => {
	it("types relation where filters on users", () => {
		type UsersWhere = WhereInput<
			Schema["users"]["_columns"],
			Schema,
			"users"
		>;
		type ValidWhere = {
			posts: { some: { published: true } };
		};
		expectTypeOf<ValidWhere>().toExtend<UsersWhere>();
	});

	it("types nested with on posts", () => {
		type ValidWith = {
			author: {
				select: ["id", "email", "name"];
				with: {
					profile: true;
				};
			};
			comments: {
				orderBy: { createdAt: "asc" };
				with: {
					author: { select: ["id", "name"] };
				};
			};
			tags: true;
		};
		expectTypeOf<ValidWith>().toExtend<PostsWith>();
	});

	it("types select object and orderBy columns", () => {
		type ValidWith = {
			author: {
				select: { id: true; email: true; name: true };
				with: {
					profile: true;
				};
			};
			comments: {
				orderBy: { createdAt: "asc" };
				with: {
					author: { select: { id: true; name: true } };
				};
			};
			tags: true;
		};
		expectTypeOf<ValidWith>().toExtend<PostsWith>();
	});
});
