import { describe, expect, it } from "vitest";
import { emitIncludesTs } from "../src/codegen/emit-includes.js";
import { emitModelsTs } from "../src/codegen/emit-models.js";
import { emitQueryTypesTs } from "../src/codegen/emit-query-types.js";
import { emitClientTs } from "../src/codegen/generate.js";
import { schemaToManifest } from "../src/codegen/schema-to-manifest.js";
import {
	bool,
	defineSchema,
	enumType,
	fk,
	id,
	table,
	text,
	timestamps,
	uuid,
} from "../src/schema/index.js";

const LEAKED_TYPE_NAMES = [
	"TableDef",
	"ColumnBuilder",
	"ColumnMeta",
	"CreateArgsWith",
	"FindManyArgsWith",
	"TimestampColumnBuilder",
	"TextColumnBuilder",
	"typeof schema._tables",
];

function blogLikeManifest() {
	const schema = defineSchema({
		users: table({
			id: uuid().primary(),
			email: text().notNull().unique(),
			name: text(),
			password: text().notNull().hidden(),
			...timestamps(),
		}),
		posts: table({
			id: id(),
			authorId: fk("users").notNull().index().onDelete("restrict"),
			title: text().notNull(),
			body: text().notNull(),
			published: bool().notNull().default(false),
			status: enumType(["draft", "published", "archived"])
				.notNull()
				.default("draft"),
			...timestamps(),
		}),
		profiles: table({
			id: id(),
			userId: fk("users").notNull().unique().onDelete("cascade"),
			bio: text(),
		}),
	});
	return schemaToManifest(schema);
}

describe("emitQueryTypesTs", () => {
	it("emits flat row, input, and where interfaces without builder types", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		for (const leaked of LEAKED_TYPE_NAMES) {
			expect(source).not.toContain(leaked);
		}

		expect(source).toContain("export interface CreateUserInput {");
		expect(source).toContain("export interface UpdateUserInput {");
		expect(source).toContain("export interface UserWhere {");
		expect(source).toContain("export type UserWhereUnique =");
		expect(source).toContain("export interface FindManyUserArgs {");
		expect(source).toContain("export interface UserRepository {");
		expect(source).toContain("export interface NeoOrmClient {");
		expect(source).toContain("export type UserInclude = UserWith;");
	});

	it("requires create fields without defaults and omits managed timestamps", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain("email: string;");
		expect(source).toContain("password: string;");
		expect(source).not.toMatch(/CreateUserInput[^}]*createdAt/);
		expect(source).not.toMatch(/CreateUserInput[^}]*updatedAt/);
		expect(source).toContain("published?: boolean");
		expect(source).toContain("name?: string | null;");
	});

	it("emits unique-where unions and relation filters", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain("export type UserWhereUnique =");
		expect(source).toContain("id: UniqueEq<string>");
		expect(source).toContain("email: UniqueEq<string>");
		expect(source).toContain(
			"posts?: { some?: PostWhere; every?: PostWhere; none?: PostWhere };",
		);
		expect(source).toContain("profile?: ProfileWhere;");
		expect(source).toContain("author?: UserWhere;");
	});

	it("emits string operators for text columns and comparable operators for timestamps", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain("email?: string | StringFilter<string>;");
		expect(source).toContain("createdAt?: Date | ComparableFilter<Date>;");
		expect(source).toContain(
			"status?: PostStatus | StringFilter<PostStatus>;",
		);
	});
});

describe("repository overloads", () => {
	it("emits plain non-generic overloads before the narrowing generics", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		const plainFindMany =
			"findMany(args?: FindManyUserArgs & { with?: never; select?: never; omit?: never; includeHidden?: false }): Promise<Omit<User, UserHiddenKeys>[]>";
		const genericFindMany = "findMany<W extends UserWith";
		expect(source).toContain(plainFindMany);
		expect(source).toContain(genericFindMany);
		expect(source.indexOf(plainFindMany)).toBeLessThan(
			source.indexOf(genericFindMany),
		);

		const plainCreate =
			'create(args: CreateUserArgs & { with?: never; returnCreated?: false }): Promise<Pick<User, "id">>';
		const genericCreate = "create<W extends UserWith";
		expect(source).toContain(plainCreate);
		expect(source).toContain(genericCreate);
		expect(source.indexOf(plainCreate)).toBeLessThan(
			source.indexOf(genericCreate),
		);
	});

	it("emits two signatures per narrowing method", () => {
		const source = emitQueryTypesTs(blogLikeManifest());
		const userRepo = source.match(
			/export interface UserRepository \{[\s\S]*?\n\}/,
		)?.[0];
		expect(userRepo).toBeDefined();

		for (const method of [
			"findMany",
			"findFirst",
			"findUnique",
			"findById",
			"create",
			"upsert",
			"findOrCreate",
			"update",
			"updateById",
			"delete",
			"count",
			"paginate",
		]) {
			const matches = userRepo?.match(
				new RegExp(`^  ${method}[<(]`, "gm"),
			);
			expect(matches?.length, `${method} overloads`).toBe(2);
		}
	});

	it("keeps narrowing returns on the generic overloads", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain("): Promise<UserFindResult<W, S, O, IH>[]>;");
		expect(source).toContain("): Promise<UserCreateResult<W, RC>>;");
		expect(source).toContain(
			"): Promise<UserMutationResult<W, RU> | null>;",
		);
		expect(source).toContain(
			"count<const TArgs extends CountUserArgs = CountUserArgs>(args?: TArgs): Promise<CountUserResult<TArgs>>;",
		);
	});

	it("routes narrowing keys past the plain overloads", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain(
			"upsert(args: UpsertUserArgs & { with?: never }): Promise<User>;",
		);
		expect(source).toContain(
			"update(args: UpdateUserArgs & { with?: never; returnUpdated?: false }): Promise<Record<never, never> | null>;",
		);
		expect(source).toContain(
			"delete(args: DeleteUserArgs & { with?: never; returnDeleted?: false }): Promise<Record<never, never> | null>;",
		);
		expect(source).toContain(
			"count(args?: CountUserArgs & { select?: never }): Promise<number>;",
		);
		expect(source).toContain(
			"paginate(args: PaginateUserArgs & { with?: never; select?: never; omit?: never; includeHidden?: false }): Promise<PaginateResult<Omit<User, UserHiddenKeys>, Partial<User> | null>>;",
		);
	});
});

describe("flat generated client", () => {
	it("emits query-types that never reference the schema DSL", () => {
		const manifest = blogLikeManifest();
		for (const source of [
			emitModelsTs(manifest, "neoorm"),
			emitIncludesTs(manifest),
			emitQueryTypesTs(manifest),
			emitClientTs("neoorm", {}),
		]) {
			for (const leaked of LEAKED_TYPE_NAMES) {
				expect(source).not.toContain(leaked);
			}
		}
	});

	it("emits a client without a schema import", () => {
		const client = emitClientTs("neoorm", {});
		expect(client).toContain("export const db: NeoOrmClient");
		expect(client).not.toContain('from "../schema');
		expect(client).not.toContain("TypedNeoOrmClient");
		expect(client).toContain('export type * from "./query-types.js";');
	});

	it("emits interface rows and hoisted enums in models", () => {
		const models = emitModelsTs(blogLikeManifest(), "neoorm");
		expect(models).toContain("export interface User {");
		expect(models).toContain(
			'export type PostStatus = "draft" | "published" | "archived";',
		);
		expect(models).toContain("status: PostStatus;");
		expect(models).toContain("export type UserFindResult<");
		expect(models).toContain("export type UserCreateResult<");
		expect(models).toContain("export type UserMutationResult<");
	});

	it("points nested include where clauses at flat where types", () => {
		const includes = emitIncludesTs(blogLikeManifest());
		expect(includes).not.toContain("where?: Record<string, unknown>");
		expect(includes).toContain("where?: PostWhere;");
		expect(includes).toContain("where?: UserWhere;");
		expect(includes).not.toContain('from "neoorm/schema"');
	});
});
