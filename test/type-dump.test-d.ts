import type { schema } from "../examples/blog/schema.js";
import type {
	OutgoingFkRelations,
	RelationCreateMap,
} from "../src/schema/relation-types.js";

type Schema = typeof schema._tables;
type Outgoing = OutgoingFkRelations<Schema, Schema["posts"]["_columns"]>;
type CreateMap = RelationCreateMap<Schema, "posts">;

type _assertAuthorInCreateMap = CreateMap["author"] extends {
	connect: { id: string };
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
