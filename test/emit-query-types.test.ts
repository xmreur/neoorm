import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
		expect(source).toContain("where: UserWhereUnique & UserWhere;");
		const findUniqueBlock = source.match(
			/export interface FindUniqueUserArgs \{[\s\S]*?\n\}/,
		)?.[0];
		expect(findUniqueBlock).toContain("where: UserWhereUnique;");
		expect(findUniqueBlock).not.toContain("& UserWhere;");
		const upsertBlock = source.match(
			/export interface UpsertUserArgs \{[\s\S]*?\n\}/,
		)?.[0];
		expect(upsertBlock).toContain("where: UserWhereUnique;");
		expect(upsertBlock).not.toContain("& UserWhere;");
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

describe("repository signatures", () => {
	it("emits zero-arg overloads plus one constrained generic per method", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain("findMany(): Promise<UserVisible[]>;");
		expect(source).toContain(
			"findMany<const T extends FindManyUserArgs>(args: T): Promise<UserQueryResult<T>[]>;",
		);
		expect(source).toContain(
			"create<const T extends CreateUserArgs>(args: T): Promise<UserCreateQueryResult<T>>;",
		);

		// Autocomplete keys live on the full args interfaces used as constraints.
		expect(source).toContain("with?: UserWith;");
		expect(source).toContain("select?: UserSelect;");
		expect(source).toContain("omit?: UserOmit;");
		expect(source).toContain("export interface FindByIdUserArgs {");
		expect(source).toContain("export interface UpdateByIdUserArgs {");

		expect(source).not.toContain("Exact<T,");
		expect(source).not.toContain("= Record<never, never>");
		expect(source).not.toContain('Omit<FindManyUserArgs, "with"');
		expect(source).not.toContain('Omit<CreateUserArgs, "with"');
		expect(source).not.toContain("with?: never");
		expect(source).not.toContain("select?: never");
		expect(source).not.toContain("omit?: never");
	});

	it("emits zero-arg plus generic signatures per method", () => {
		const source = emitQueryTypesTs(blogLikeManifest());
		const userRepo = source.match(
			/export interface UserRepository \{[\s\S]*?\n\}/,
		)?.[0];
		expect(userRepo).toBeDefined();

		for (const method of ["findMany", "findFirst", "findById", "count"]) {
			const matches = userRepo?.match(
				new RegExp(`^  ${method}[<(]`, "gm"),
			);
			expect(matches?.length, `${method} signatures`).toBe(2);
		}

		for (const method of [
			"findUnique",
			"findOrCreate",
			"paginate",
			"create",
			"update",
			"updateById",
			"delete",
			"upsert",
		]) {
			const matches = userRepo?.match(
				new RegExp(`^  ${method}[<(]`, "gm"),
			);
			expect(matches?.length, `${method} signatures`).toBe(1);
		}
	});

	it("keeps narrowing returns on the args-object generics", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain("): Promise<UserQueryResult<T>[]>;");
		expect(source).toContain("): Promise<UserCreateQueryResult<T>>;");
		expect(source).toContain("): Promise<UserUpdateQueryResult<T>>;");
		expect(source).toContain("): Promise<UserDeleteQueryResult<T>>;");
		expect(source).toContain("): Promise<UserUpsertQueryResult<T>>;");
		expect(source).toContain(
			"count<const T extends CountUserArgs>(args: T): Promise<CountUserResult<T>>;",
		);
	});

	it("keeps runtime-accurate result wrappers on single signatures", () => {
		const source = emitQueryTypesTs(blogLikeManifest());

		expect(source).toContain(
			"update<const T extends UpdateUserArgs>(args: T): Promise<UserUpdateQueryResult<T>>;",
		);
		expect(source).toContain(
			"delete<const T extends DeleteUserArgs>(args: T): Promise<UserDeleteQueryResult<T>>;",
		);
		expect(source).toContain(
			"upsert<const T extends UpsertUserArgs>(args: T): Promise<UserUpsertQueryResult<T>>;",
		);
		expect(source).toContain(
			"paginate<const T extends PaginateUserArgs>(args: T): Promise<PaginateResult<UserQueryResult<T>, Partial<User> | null>>;",
		);
		expect(source).toContain(
			"findById<const T extends FindByIdUserArgs>(id: string | Record<string, unknown>, args: T): Promise<UserQueryResult<T> | null>;",
		);
		expect(source).toContain(
			"updateById<const T extends UpdateByIdUserArgs>(id: string | Record<string, unknown>, args: T): Promise<UserUpdateQueryResult<T>>;",
		);
	});

	it("emits cheap result helpers in models", () => {
		const models = emitModelsTs(blogLikeManifest(), "neoorm");
		expect(models).toContain(
			"export type UserVisible = Omit<User, UserHiddenKeys>;",
		);
		expect(models).toContain(
			'export type UserCreateDefault = Pick<User, "id">;',
		);
		expect(models).toContain("interface UserRelationRow {");
		expect(models).toContain("interface UserRelationMany {");
		expect(models).toContain("export type UserRelations<W>");
		expect(models).not.toContain("Relations<W extends");
		expect(models).not.toContain("IncludeRelation<");
		expect(models).not.toContain("IncludeCount<");
		expect(models).not.toContain("infer W extends UserWith");
		expect(models).toContain("export type UserQueryResult<T>");
		expect(models).toContain("Extract<keyof T,");
		expect(models).toContain("type UserRowPart<T>");
		expect(models).toContain("type UserNarrowQueryResult<T>");
		expect(models).toContain("export type UserCreateQueryResult<T>");
		expect(models).toContain("export type UserUpdateQueryResult<T>");
		expect(models).toContain("export type UserDeleteQueryResult<T>");
		expect(models).toContain("export type UserUpsertQueryResult<T>");
		expect(models).toContain("export type UserCreateResult<W>");
		expect(models).toContain("export type UserMutationResult<W>");
		expect(models).not.toContain("type SelectOf<T>");
		expect(models).not.toContain("type OmitOf<T>");
		expect(models).not.toContain("type HiddenOf<T>");
	});
});

const CHEAP_PATH_SHIM = `type StripSelectKeys<O> = O extends readonly (infer K extends PropertyKey)[]
  ? K
  : O extends Record<string, unknown>
    ? { [K in keyof O]: O[K] extends true ? K : never }[keyof O]
    : never;
export type StripCapablePayload<
  TRow extends object,
  THidden extends keyof TRow & string = never,
> = TRow & {
  strip<
    const O extends
      | readonly (keyof TRow & string)[]
      | Partial<Record<keyof TRow & string, true>>
      | undefined = undefined,
  >(omit?: O): Omit<TRow, THidden | StripSelectKeys<O>>;
};
`;

const CHEAP_PATH_USAGE = `import type { NeoOrmClient } from "./query-types.js";
import type { Post, User, UserHiddenKeys } from "./models.js";

declare const db: NeoOrmClient;

function assertType<T>(value: T): void {
  void value;
}

export async function check(): Promise<void> {
  const common = await db.users.findMany();
  assertType<Omit<User, UserHiddenKeys>[]>(common);

  const filtered = await db.users.findMany({
    where: { email: "a@b.c" },
    take: 10,
  });
  assertType<Omit<User, UserHiddenKeys>[]>(filtered);

  const withPosts = await db.users.findMany({ with: { posts: true } });
  assertType<Post[] | undefined>(withPosts[0]?.posts);
  // @ts-expect-error - profile was not requested
  assertType<undefined>(withPosts[0]?.profile);

  const selected = await db.users.findMany({ select: { email: true } });
  assertType<{ email: string }[]>(selected);

  const omitted = await db.users.findMany({ omit: { password: true } });
  assertType<Omit<User, "password">[]>(omitted);

  const withHidden = await db.users.findMany({ includeHidden: true });
  assertType<User[]>(withHidden);

  const first = await db.users.findFirst();
  assertType<Omit<User, UserHiddenKeys> | null>(first);

  const byId = await db.users.findById("user_1");
  assertType<Omit<User, UserHiddenKeys> | null>(byId);

  const created = await db.users.create({
    data: { email: "a@b.c", password: "secret" },
  });
  assertType<Pick<User, "id">>(created);

  const createdFull = await db.users.create({
    data: { email: "a@b.c", password: "secret" },
    returnCreated: true,
  });
  assertType<User>(createdFull);

  const createdExplicitDefault = await db.users.create({
    data: { email: "a@b.c", password: "secret" },
    returnCreated: false,
  });
  assertType<Pick<User, "id">>(createdExplicitDefault);

  const createdWith = await db.users.create({
    data: { email: "a@b.c", password: "secret" },
    with: { posts: true },
  });
  assertType<Post[] | undefined>(createdWith.posts);

  const createdWithAndFlag = await db.users.create({
    data: { email: "a@b.c", password: "secret" },
    with: { posts: true },
    returnCreated: true,
  });
  assertType<Post[] | undefined>(createdWithAndFlag.posts);

  const updated = await db.users.update({
    where: { id: "user_1" },
    data: { name: "Ada" },
  });
  assertType<Record<never, never> | null>(updated);

  const updatedExplicitDefault = await db.users.update({
    where: { id: "user_1" },
    data: { name: "Ada" },
    returnUpdated: false,
  });
  assertType<Record<never, never> | null>(updatedExplicitDefault);

  const updatedFull = await db.users.update({
    where: { id: "user_1" },
    data: { name: "Ada" },
    returnUpdated: true,
  });
  assertType<User | null>(updatedFull);

  const upserted = await db.users.upsert({
    where: { id: "user_1" },
    create: { email: "a@b.c", password: "secret" },
    update: {},
  });
  assertType<User>(upserted);

  const deleted = await db.users.delete({ where: { id: "user_1" } });
  assertType<Record<never, never> | null>(deleted);

  const deletedExplicitDefault = await db.users.delete({
    where: { id: "user_1" },
    returnDeleted: false,
  });
  assertType<Record<never, never> | null>(deletedExplicitDefault);

  const total = await db.users.count();
  assertType<number>(total);
}
`;

describe("cheap-path overload narrowing", () => {
	it("typechecks common vs with vs select vs mutation returns", async () => {
		const manifest = blogLikeManifest();
		const dir = await mkdtemp(join(tmpdir(), "neoorm-cheap-path-"));
		try {
			await writeFile(join(dir, "shim.ts"), CHEAP_PATH_SHIM, "utf-8");
			await writeFile(
				join(dir, "models.ts"),
				emitModelsTs(manifest, "./shim.js"),
				"utf-8",
			);
			await writeFile(
				join(dir, "includes.ts"),
				emitIncludesTs(manifest),
				"utf-8",
			);
			await writeFile(
				join(dir, "query-types.ts"),
				emitQueryTypesTs(manifest),
				"utf-8",
			);
			await writeFile(join(dir, "usage.ts"), CHEAP_PATH_USAGE, "utf-8");
			await writeFile(
				join(dir, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
						strict: true,
						exactOptionalPropertyTypes: true,
						noUncheckedIndexedAccess: true,
						skipLibCheck: true,
						noEmit: true,
					},
					include: ["usage.ts"],
				}),
				"utf-8",
			);

			const require = createRequire(import.meta.url);
			const tscBin = join(
				dirname(require.resolve("typescript/package.json")),
				"bin",
				"tsc",
			);
			let output = "";
			try {
				output = execFileSync(
					process.execPath,
					[tscBin, "-p", join(dir, "tsconfig.json")],
					{ encoding: "utf-8", stdio: "pipe", timeout: 120000 },
				);
			} catch (error) {
				const failed = error as {
					stdout?: unknown;
					stderr?: unknown;
					message?: string;
				};
				const detail = [failed.stdout, failed.stderr, failed.message]
					.filter(
						(part) => typeof part === "string" && part.length > 0,
					)
					.join("\n");
				expect(
					detail,
					"generated overload usage should typecheck",
				).toBe("");
				return;
			}
			expect(output).toBe("");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120000);
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
