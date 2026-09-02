import {
	bool,
	decimal,
	defineSchema,
	enumType,
	fk,
	id,
	int,
	jsonb,
	manyToMany,
	table,
	text,
	timestamp,
	uuid,
} from "neoorm/schema";

export const schema = defineSchema({
	users: table("users", {
		id: uuid().primary(),
		email: text().notNull().unique(),
		name: text(),
		createdAt: timestamp().notNull().defaultNow(),
		updatedAt: timestamp().notNull().defaultNow().updatedAt(),
	}),

	profiles: table("profiles", {
		id: id.primary(),
		// `as`/`inverse` can be overridden; `unique` makes it a to-one relation.
		userId: fk("users.id", {
			inverse: "profile",
			unique: true,
			nullable: false,
			onDelete: "cascade",
		}),
		bio: text(),
		avatarUrl: text(),
	}),

	posts: table("posts", {
		id: id.primary(),
		// `.index()` on a column is shorthand for a single-column index.
		authorId: fk("users.id", {
			inverse: "posts",
			nullable: false,
			onDelete: "restrict",
		}).index(),
		title: text().notNull(),
		body: text().notNull(),
		published: bool().notNull().default(false),
		views: int().notNull().default(0),
		status: enumType(["draft", "published", "archived"] as const)
			.notNull()
			.default("draft"),
		metadata: jsonb<Record<string, unknown>>(),
		price: decimal({ precision: 10, scale: 2 }),
		createdAt: timestamp().notNull().defaultNow(),
		updatedAt: timestamp().notNull().defaultNow().updatedAt(),
	}),

	comments: table("comments", {
		id: id.primary(),
		postId: fk("posts.id", {
			inverse: "comments",
			nullable: false,
			onDelete: "cascade",
		}),
		authorId: fk("users.id", {
			inverse: "comments",
			nullable: false,
		}),
		body: text().notNull(),
		createdAt: timestamp().notNull().defaultNow(),
	}),

	tags: table("tags", {
		id: id.primary(),
		slug: text().notNull().unique(),
		name: text().notNull(),
	}),

	postTags: table("post_tags", {
		// Composite primary key inline via `.primary()` on the FK columns.
		postId: fk("posts.id", {
			inverse: "postTags",
			nullable: false,
		}).primary(),
		tagId: fk("tags.id", {
			inverse: "postTags",
			nullable: false,
		}).primary(),
		assignedBy: text(),
		assignedAt: timestamp().notNull().defaultNow(),
	}),
});

manyToMany(schema.posts, schema.tags, {
	through: schema.postTags,
	left: "post",
	right: "tag",
	as: "tags",
	inverse: "posts",
});