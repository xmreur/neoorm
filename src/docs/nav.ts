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

export type DocsPageMeta = {
	group: DocsGroupId;
	order: number;
	description: string;
	keywords?: string;
	hidden?: boolean;
};

/**
 * Sidebar placement and card copy for each page. Frontmatter can override
 * title/description later, but group and order stay here so navigation is
 * deterministic even for a partially written page.
 */
export const PAGE_META: Record<string, DocsPageMeta> = {
	"getting-started": {
		group: "start",
		order: 10,
		description:
			"Install NeoOrm, scaffold a project, and run your first migration.",
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
			"Tables, columns, foreign keys, indexes, and many-to-many relations.",
		keywords:
			"table column fk foreignKey many index unique primaryKey enum check timestamps",
	},
	relations: {
		group: "schema",
		order: 20,
		description:
			"Nested connect, create, set, disconnect, and delete writes.",
		keywords:
			"connect connectOrCreate create disconnect set delete nested writes",
	},
	plugins: {
		group: "schema",
		order: 30,
		description: "PostGIS, citext, and custom column-type plugins.",
	},
	queries: {
		group: "queries",
		order: 10,
		description:
			"Find, create, update, delete, filter, paginate, and aggregate.",
		keywords:
			"findMany findFirst findUnique create createMany update updateMany delete deleteMany upsert findOrCreate",
	},
	transactions: {
		group: "queries",
		order: 20,
		description:
			"Interactive, batch, nested, and isolation-level transactions.",
		keywords: "$transaction isolation serializable repeatable read",
	},
	errors: {
		group: "queries",
		order: 30,
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
	zod: {
		group: "validation",
		order: 10,
		description: "Generate Zod 4 schemas for rows, inserts, and updates.",
	},
	typebox: {
		group: "validation",
		order: 20,
		description:
			"Generate TypeBox 1.x schemas for rows, inserts, and updates.",
	},
	elysia: {
		group: "validation",
		order: 30,
		description:
			"Generate Elysia `t` schemas for route bodies and queries.",
	},
	sqlite: {
		group: "dialects",
		order: 10,
		description: "SQLite drivers, configuration, and type mapping.",
	},
	mysql: {
		group: "dialects",
		order: 20,
		description: "MySQL 8 setup, type mapping, and limitations.",
	},
	mariadb: {
		group: "dialects",
		order: 30,
		description: "MariaDB 10.11 setup, type mapping, and limitations.",
	},
	examples: {
		group: "guides",
		order: 10,
		description:
			"Copy-paste schema, query, relation, and migration patterns.",
	},
	"api-docstrings": {
		group: "contributing",
		order: 10,
		description: "TSDoc conventions for public NeoOrm exports.",
	},
	"migrate-dev-workflow": {
		group: "contributing",
		order: 90,
		description: "Internal migrate dev implementation record.",
		hidden: true,
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
