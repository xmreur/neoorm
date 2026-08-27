import { describe, expectTypeOf, it } from "vitest";
import type { schema } from "../examples/blog/schema.js";
import type {
	InferAggregateResult,
	InferCountResult,
	InferFindResult,
	InferGroupByResult,
	InferWithResult,
} from "../src/schema/types.js";

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

		type _Check = Expect<
			Result extends { _count?: { posts: number } } ? true : false
		>;
		const _assert: _Check = true;
		void _assert;
	});

	it("keeps full row when with is undefined", () => {
		type Result = InferWithResult<
			typeof schema._tables,
			"users",
			undefined,
			UserRow
		>;
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

describe("root select / omit return types", () => {
	it("narrows parent fields with object select", () => {
		type Result = InferFindResult<
			typeof schema._tables,
			"users",
			undefined,
			{ id: true; email: true },
			undefined,
			UserRow
		>;
		expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }>();
	});

	it("narrows parent fields with array select", () => {
		type Result = InferFindResult<
			typeof schema._tables,
			"users",
			undefined,
			["id", "email"],
			undefined,
			UserRow
		>;
		expectTypeOf<Result>().toEqualTypeOf<{ id: string; email: string }>();
	});

	it("drops omitted parent fields", () => {
		type Result = InferFindResult<
			typeof schema._tables,
			"users",
			undefined,
			undefined,
			{ createdAt: true; updatedAt: true },
			UserRow
		>;
		expectTypeOf<Result>().toEqualTypeOf<{
			id: string;
			email: string;
			name: string;
		}>();
	});

	it("composes select with nested with", () => {
		type Result = InferFindResult<
			typeof schema._tables,
			"posts",
			{ author: { select: { email: true } } },
			{ id: true; title: true },
			undefined,
			PostRow
		>;
		type _Parent = Expect<
			Result extends { id: string; title: string } ? true : false
		>;
		type _Author = Expect<
			Result extends { author: { email: string } | null } ? true : false
		>;
		const _assertParent: _Parent = true;
		const _assertAuthor: _Author = true;
		void _assertParent;
		void _assertAuthor;
	});

	it("composes omit with nested with", () => {
		type Result = InferFindResult<
			typeof schema._tables,
			"posts",
			{ author: true },
			undefined,
			{ body: true; metadata: true },
			PostRow
		>;
		type _Parent = Expect<
			Result extends { id: string; title: string } ? true : false
		>;
		type _NoBody = Expect<
			keyof Result & "body" extends never ? true : false
		>;
		type _NoMetadata = Expect<
			keyof Result & "metadata" extends never ? true : false
		>;
		const _assertParent: _Parent = true;
		const _assertBody: _NoBody = true;
		const _assertMetadata: _NoMetadata = true;
		void _assertParent;
		void _assertBody;
		void _assertMetadata;
	});

	it("is never when select and omit are both set", () => {
		type Result = InferFindResult<
			typeof schema._tables,
			"users",
			undefined,
			{ id: true },
			{ email: true },
			UserRow
		>;
		expectTypeOf<Result>().toBeNever();
	});
});

describe("groupBy return types", () => {
	it("includes grouped scalars and selected aggregates", () => {
		type FromArray = InferGroupByResult<
			{
				by: readonly ["authorId"];
				_count: true;
				_avg: { views: true };
			},
			PostRow
		>;
		type FromObject = InferGroupByResult<
			{
				by: { authorId: true };
				_count: true;
				_avg: { views: true };
			},
			PostRow
		>;

		expectTypeOf<FromArray>().toMatchTypeOf<{
			authorId: string;
			_count: number;
			_avg: { views: number | null };
		}>();
		expectTypeOf<FromObject>().toMatchTypeOf<{
			authorId: string;
			_count: number;
			_avg: { views: number | null };
		}>();
		expectTypeOf<FromArray["authorId"]>().toEqualTypeOf<string>();
		expectTypeOf<FromObject["_count"]>().toEqualTypeOf<number>();
	});

	it("uses a field _count object when _count is a select map", () => {
		type Result = InferGroupByResult<
			{
				by: readonly ["status"];
				_count: { _all: true; authorId: true };
			},
			PostRow
		>;
		expectTypeOf<Result>().toMatchTypeOf<{
			status: string;
			_count: { _all: number; authorId: number };
		}>();
		expectTypeOf<Result["_count"]>().toEqualTypeOf<{
			_all: number;
			authorId: number;
		}>();
	});
});

describe("count and aggregate return types", () => {
	it("returns a number unless count select is set", () => {
		expectTypeOf<InferCountResult<object>>().toEqualTypeOf<number>();
		expectTypeOf<
			InferCountResult<{ where: { email: string } }>
		>().toEqualTypeOf<number>();
		expectTypeOf<
			InferCountResult<{ distinct: "email" }>
		>().toEqualTypeOf<number>();
		expectTypeOf<
			InferCountResult<{ select: { _all: true; email: true } }>
		>().toEqualTypeOf<{ _all: number; email: number }>();
	});

	it("keeps _count: true as a number and a field map as an object", () => {
		expectTypeOf<InferAggregateResult<{ _count: true }>>().toEqualTypeOf<{
			_count: number;
		}>();
		expectTypeOf<
			InferAggregateResult<{ _count: { email: true } }>
		>().toEqualTypeOf<{ _count: { email: number } }>();
		expectTypeOf<
			InferAggregateResult<{
				_count: { _all: true; authorId: true };
				_avg: { views: true };
			}>
		>().toMatchTypeOf<{
			_count: { _all: number; authorId: number };
			_avg: { views: number | null };
		}>();
	});
});
