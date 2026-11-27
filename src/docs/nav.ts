import type { DocsPage } from "./pages.js";

export const DOC_GROUPS = [
	{ id: "start", label: "Start here" },
	{ id: "schema", label: "Schema" },
	{ id: "queries", label: "Queries" },
	{ id: "tooling", label: "Database & tooling" },
	{ id: "validation", label: "Validation" },
	{ id: "dialects", label: "Dialects" },
	{ id: "guides", label: "Guides" },
	{ id: "contributing", label: "Contributing" },
] as const;

export type DocsGroupId = (typeof DOC_GROUPS)[number]["id"];

const GROUP_IDS = new Set<string>(DOC_GROUPS.map((group) => group.id));

export function isDocsGroupId(value: string): value is DocsGroupId {
	return GROUP_IDS.has(value);
}

export type DocsPageMeta = {
	group: DocsGroupId;
	order: number;
	description: string;
	keywords?: string;
	hidden?: boolean;
};

/**
 * Default sidebar placement, card copy, and search keywords per slug.
 * Frontmatter (`title`, `description`, `group`, `order`) can override these.
 */
export const PAGE_META: Record<string, DocsPageMeta> = {
	"getting-started": {
		group: "start",
		order: 10,
		description:
			"Install NeoORM, scaffold a project, and run your first migration.",
	},
	configuration: {
		group: "start",
		order: 20,
		description:
			"Configure the schema path, output directory, and datasource.",
	},
	studio: {
		group: "start",
		order: 30,
		description: "Browse and edit data with the local Studio UI.",
		keywords:
			"studio data grid sql console query playground schema explorer er graph",
	},
	schema: {
		group: "schema",
		order: 10,
		description:
			"Tables, column types, checks, indexes, enums, and naming strategies.",
		keywords:
			"table column index unique primaryKey enum check timestamps tsvector generated map",
	},
	"schema-relations": {
		group: "schema",
		order: 20,
		description:
			"Foreign keys, composite keys, self-relations, and many-to-many tables.",
		keywords:
			"fk foreignKey many through junction composite self relation inverse hoisted",
	},
	plugins: {
		group: "schema",
		order: 30,
		description: "PostGIS, citext, and custom column-type plugins.",
	},
	queries: {
		group: "queries",
		order: 10,
		description: "Find, create, update, delete, upsert, and findOrCreate.",
		keywords:
			"findMany findFirst findUnique findById create createMany createManyAndReturn update updateMany delete deleteMany upsert findOrCreate",
	},
	filters: {
		group: "queries",
		order: 20,
		description:
			"Where operators, relation filters, pagination, count, and aggregates.",
		keywords:
			"where filter contains searchTs jsonContains some every none paginate cursor groupBy aggregate count exists distinct",
	},
	loading: {
		group: "queries",
		order: 30,
		description:
			"Eager loading with `with`, `select`/`omit`, `.hidden()`, and `.strip()`.",
		keywords:
			"with eager loading join json_agg select omit hidden includeHidden strip",
	},
	relations: {
		group: "queries",
		order: 40,
		description:
			"Nested connect, create, set, disconnect, and delete writes.",
		keywords:
			"connect connectOrCreate create disconnect set delete nested writes",
	},
	transactions: {
		group: "queries",
		order: 50,
		description:
			"Interactive, batch, nested, and isolation-level transactions.",
		keywords:
			"$transaction isolation serializable repeatable read savepoint",
	},
	"raw-sql": {
		group: "queries",
		order: 60,
		description:
			"Parameterized `db.sql`, `sqlBuilder`, `db.execute`, and query logging.",
		keywords:
			"sql sqlId sqlBuilder execute raw beforeQuery afterQuery logging",
	},
	errors: {
		group: "queries",
		order: 70,
		description:
			"Structured error codes, constraint subclasses, and fixes.",
		keywords:
			"NeoOrmError NeoOrmQueryError UniqueViolationError ForeignKeyViolationError NotNullViolationError CheckViolationError",
	},
	migrations: {
		group: "tooling",
		order: 10,
		description: "Generate, deploy, roll back, and reset migrations.",
		keywords:
			"migrate dev deploy diff status down reset db push pull snapshot",
	},
	seeding: {
		group: "tooling",
		order: 20,
		description: "Run idempotent, transactional seed scripts.",
		keywords: "seed seeding seed.ts environment",
	},
	cli: {
		group: "tooling",
		order: 30,
		description: "Every `neoorm` command and flag.",
		keywords: "init generate migrate seed studio docs db push pull",
	},
	validation: {
		group: "validation",
		order: 10,
		description: "Compare Zod, TypeBox 1.x, and Elysia `t` schema codegen.",
		keywords: "validation zod typebox elysia ir schema codegen",
	},
	zod: {
		group: "validation",
		order: 20,
		description: "Generate Zod 4 schemas for rows, inserts, and updates.",
	},
	typebox: {
		group: "validation",
		order: 30,
		description:
			"Generate TypeBox 1.x schemas for rows, inserts, and updates.",
	},
	elysia: {
		group: "validation",
		order: 40,
		description:
			"Generate Elysia `t` schemas for route bodies and queries.",
	},
	postgresql: {
		group: "dialects",
		order: 10,
		description:
			"PostgreSQL setup, pools, schemas, extensions, JSONB, and ranges.",
		keywords:
			"postgres postgresql pg pool schema extensions jsonb array range",
	},
	sqlite: {
		group: "dialects",
		order: 20,
		description: "SQLite drivers, configuration, and type mapping.",
	},
	mysql: {
		group: "dialects",
		order: 30,
		description: "MySQL 8 setup, type mapping, and limitations.",
	},
	mariadb: {
		group: "dialects",
		order: 40,
		description: "MariaDB 10.11 setup, type mapping, and limitations.",
	},
	examples: {
		group: "guides",
		order: 10,
		description:
			"End-to-end recipes for auth, feeds, soft deletes, search, and PostGIS.",
		keywords: "cookbook recipes examples auth feed soft delete postgis",
	},
	"api-docstrings": {
		group: "contributing",
		order: 10,
		description: "TSDoc conventions for public NeoORM exports.",
	},
};

export function isHiddenPage(page: DocsPage): boolean {
	return page.hidden;
}

export function visiblePages(pages: DocsPage[]): DocsPage[] {
	return pages.filter((page) => !page.hidden);
}

export function groupPages(
	pages: DocsPage[],
): { id: DocsGroupId; label: string; pages: DocsPage[] }[] {
	const visible = visiblePages(pages);
	return DOC_GROUPS.map((group) => ({
		...group,
		pages: visible
			.filter((page) => page.group === group.id)
			.sort(
				(a, b) => a.order - b.order || a.title.localeCompare(b.title),
			),
	})).filter((group) => group.pages.length > 0);
}

export function orderedVisiblePages(pages: DocsPage[]): DocsPage[] {
	return groupPages(pages).flatMap((group) => group.pages);
}
