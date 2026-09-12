import { describe, expectTypeOf, it } from "vitest";
import { defineSchema, fk, id, table, text } from "../src/schema/index.js";
import type { WhereInput } from "../src/schema/relation-types.js";

const schema = defineSchema({
	posts: table({
		id: id(),
	}),
	comments: table({
		id: id(),
		postId: fk("posts").notNull(),
		replyToId: fk("comments")
			.as("replyTo")
			.inverse("replies")
			.onDelete("cascade"),
		body: text().notNull(),
	}),
});

type TSchema = typeof schema._tables;

type CommentWhere = WhereInput<
	TSchema["comments"]["_columns"],
	TSchema,
	"comments"
>;

describe("self-referential relation where types", () => {
	it("accepts scalar where for delete", () => {
		expectTypeOf<{
			id: string;
			postId: string;
		}>().toMatchTypeOf<CommentWhere>();
	});

	it("accepts one-level replyTo filter", () => {
		expectTypeOf<{
			replyTo: { id: string };
		}>().toMatchTypeOf<CommentWhere>();
	});

	it("accepts one-level replies filter", () => {
		expectTypeOf<{
			replies: { some: { body: string } };
		}>().toMatchTypeOf<CommentWhere>();
	});
});

// Deeply nested self-relation filters are intentionally excluded (ShallowWhereInput).
type _nestedReplyToRejected = {
	replyTo: { replyTo: { id: string } };
} extends CommentWhere
	? never
	: true;
type _assertNestedReplyToRejected = _nestedReplyToRejected;
