import {
  defineSchema,
  table,
  id,
  text,
  bool,
  int,
  timestamp,
  jsonb,
  decimal,
  enumType,
  fk,
  index,
  unique,
  manyToMany,
  primaryKey,
} from "neoorm/schema";

export const schema = defineSchema({
  users: table("users", {
    id: id.primary(),
    email: text().notNull().unique(),
    name: text(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow().updatedAt(),
  }),

  profiles: table("profiles", {
    id: id.primary(),
    userId: fk("users.id", {
      as: "user",
      inverse: "profile",
      unique: true,
      nullable: false,
      onDelete: "cascade",
    }),
    bio: text(),
    avatarUrl: text(),
  }),

  posts: table(
    "posts",
    {
      id: id.primary(),
      authorId: fk("users.id", {
        as: "author",
        inverse: "posts",
        nullable: false,
        onDelete: "restrict",
      }),
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
    },
    (t) => ({
      authorIdx: index().on(t.authorId),
    }),
  ),

  comments: table(
    "comments",
    {
      id: id.primary(),
      postId: fk("posts.id", {
        as: "post",
        inverse: "comments",
        nullable: false,
        onDelete: "cascade",
      }),
      authorId: fk("users.id", {
        as: "author",
        inverse: "comments",
        nullable: false,
      }),
      body: text().notNull(),
      createdAt: timestamp().notNull().defaultNow(),
    },
    (t) => ({
      postIdx: index().on(t.postId),
      authorIdx: index().on(t.authorId),
    }),
  ),

  tags: table("tags", {
    id: id.primary(),
    slug: text().notNull().unique(),
    name: text().notNull(),
  }),

  postTags: table(
    "post_tags",
    {
      postId: fk("posts.id", { as: "post", inverse: "postTags", nullable: false }),
      tagId: fk("tags.id", { as: "tag", inverse: "postTags", nullable: false }),
      assignedBy: text(),
      assignedAt: timestamp().notNull().defaultNow(),
    },
    (t) => ({
      pk: primaryKey(t.postId, t.tagId),
    }),
  ),
}, {
    columnNaming: "camelCase",
});

manyToMany(schema.posts, schema.tags, {
  through: schema.postTags,
  left: "post",
  right: "tag",
  as: "tags",
  inverse: "posts",
});
