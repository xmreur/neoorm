import type { schema } from "../examples/blog/schema.js";
import type { WhereInput } from "../src/schema/types.js";

type Schema = typeof schema._tables;
type PostsWhere = WhereInput<Schema["posts"]["_columns"], Schema, "posts">;

function expectPostsWhere(value: PostsWhere): void {
	void value;
}

// valid controls — these must keep compiling
expectPostsWhere({ title: "Hello" });
expectPostsWhere({ title: { contains: "Hi", mode: "insensitive" } });
expectPostsWhere({ views: { gte: 10, lt: 100 } });
expectPostsWhere({ price: { gte: "9.99" } });
expectPostsWhere({ author: { email: "a@b.com" } });
expectPostsWhere({ AND: [{ published: true }, { views: { gt: 0 } }] });

// @ts-expect-error -- unknown top-level filter key
expectPostsWhere({ titl: "x" });

// @ts-expect-error -- decimal columns do not support string contains
expectPostsWhere({ price: { contains: "9" } });

// @ts-expect-error -- int columns do not support string contains
expectPostsWhere({ views: { contains: "1" } });

// @ts-expect-error -- timestamp columns do not support string contains
expectPostsWhere({ createdAt: { contains: "2026" } });

// @ts-expect-error -- wrong value type for int operator
expectPostsWhere({ views: { gte: "abc" } });

// @ts-expect-error -- wrong scalar type for bool column
expectPostsWhere({ published: "yes" });

// @ts-expect-error -- unknown key in nested relation filter
expectPostsWhere({ author: { emial: "a@b.com" } });

// @ts-expect-error -- wrong operator in nested relation filter
expectPostsWhere({ author: { name: { contains: 42 } } });

// full-text search operator — valid forms keep compiling
expectPostsWhere({ title: { searchTs: "orm tutorial" } });
expectPostsWhere({
	title: { searchTs: { query: "orm", language: "german", parser: "phrase" } },
});

// @ts-expect-error -- unknown searchTs parser
expectPostsWhere({ title: { searchTs: { query: "x", parser: "nope" } } });
