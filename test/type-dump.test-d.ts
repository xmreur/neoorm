import type { schema } from "../examples/blog/schema.js";
import type { RelationCreateMap } from "../src/schema/relation-types.js";

type Schema = typeof schema._tables;
type CreateMap = RelationCreateMap<Schema, "posts">;

type _assertAuthorInCreateMap = CreateMap["author"] extends {
	connect?: { id: string };
	connectOrCreate?: {
		where: { email?: string };
		create: { email: string; password: string };
	};
}
	? true
	: never;
type _assertTagsInCreateMap = CreateMap["tags"] extends {
	connectOrCreate: {
		where: { slug?: string };
		create: { slug: string; name: string };
	}[];
}
	? true
	: never;

declare const _author: _assertAuthorInCreateMap;
declare const _tags: _assertTagsInCreateMap;
