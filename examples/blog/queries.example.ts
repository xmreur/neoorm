/**
 * Example query usage for the blog schema.
 * Run `neoorm generate` then use the generated client.
 */
import { db } from "./neoorm/client.js";

export async function exampleQueries() {
  const users = await db.users.findMany();

  const user = await db.users.findById("user_1", {
    with: {
      profile: true,
      posts: {
        orderBy: { createdAt: "desc" },
        with: {
          comments: true,
          tags: true,
        },
      },
    },
  });

  const post = await db.posts.findFirst({
    where: {
      title: { contains: "ORM" },
    },
  });

  const usersWithPublishedPosts = await db.users.findMany({
    where: {
      posts: { some: { published: true } },
    },
  });

  const posts = await db.posts.findMany({
    where: { published: true },
    orderBy: { createdAt: "desc" },
    limit: 20,
    with: {
      author: {
        select: { id: true, email: true, name: true },
        with: {
          profile: true,
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        with: {
          author: {
            select: { id: true, name: true },
          },
        },
      },
      tags: true,
    },
  });

  // Filter by enum status and decimal price (stored as string)
  const premiumPosts = await db.posts.findMany({
    where: {
      status: "published",
      price: { gte: "9.99" },
    },
    orderBy: { price: "desc" },
  });

  // Match jsonb metadata exactly
  const taggedPosts = await db.posts.findMany({
    where: {
      metadata: { featured: true, category: "engineering" },
    },
  });

  const newPost = await db.posts.create({
    data: {
      title: "NeoORM",
      body: "FK-first relations with jsonb, decimal, and enum columns.",
      published: true,
      status: "published",
      price: "19.99",
      metadata: {
        featured: true,
        category: "engineering",
        readingTimeMinutes: 8,
      },
      author: {
        connect: { id: "user_1" },
      },
      tags: {
        connectOrCreate: [
          {
            where: { slug: "orm" },
            create: { slug: "orm", name: "ORM" },
          },
          {
            where: { slug: "typescript" },
            create: { slug: "typescript", name: "TypeScript" },
          },
        ],
      },
    },
    with: {
      author: true,
      tags: true,
    },
  });

  const rows = await db.sql`
    SELECT
      u.id,
      u.email,
      count(p.id) as post_count,
      coalesce(sum(p.price::numeric), 0) as total_price
    FROM users u
    LEFT JOIN posts p ON p.author_id = u.id
    WHERE p.status = 'published' OR p.status IS NULL
    GROUP BY u.id, u.email
    ORDER BY post_count DESC
  `;

  return {
    users,
    usersWithPublishedPosts,
    user,
    post,
    posts,
    premiumPosts,
    taggedPosts,
    newPost,
    rows,
  };
}

export async function exampleMutations() {
  const updated = await db.users.update({
    where: { email: "test@example.com" },
    data: { name: "Updated Name" },
  });

  const updatedById = await db.users.updateById("user_1", {
    data: { name: "NeoOrm User" },
  });

  const count = await db.posts.updateMany({
    where: { published: false },
    data: { views: 0 },
  });

  const priceUpdate = await db.posts.updateMany({
    where: {
      status: "draft",
      price: { isNull: true },
    },
    data: {
      price: "0.00",
      metadata: { pricingTier: "free" },
    },
  });

  const publishPost = await db.posts.update({
    where: { title: "NeoORM" },
    data: {
      status: "published",
      published: true,
      metadata: {
        featured: true,
        publishedAt: new Date().toISOString(),
      },
    },
  });

  const withRelationWrites = await db.posts.update({
    where: { title: "NeoORM" },
    data: {
      comments: {
        create: [
          {
            body: "Added via relation write",
            author: { connect: { id: "user_1" } },
          },
        ],
      },
      tags: {
        set: [{ id: "tag_1" }],
      },
    },
    with: { comments: true, tags: true },
  });

  const relationOnlyUpdate = await db.posts.update({
    where: { title: "NeoORM" },
    data: {
      tags: { disconnect: [{ id: "tag_1" }] },
    },
    with: { tags: true },
  });

  const seeded = await db.tags.createMany({
    data: [
      { slug: "batch-a", name: "Batch A" },
      { slug: "batch-b", name: "Batch B" },
    ],
  });

  const deleted = await db.posts.delete({
    where: { title: "Draft post" },
  });

  const deletedCount = await db.comments.deleteMany({
    where: { postId: "post_1" },
  });

  const deletedUser = await db.users.deleteById("user_1");

  return {
    updated,
    updatedById,
    count,
    priceUpdate,
    publishPost,
    withRelationWrites,
    relationOnlyUpdate,
    seeded,
    deleted,
    deletedCount,
    deletedUser,
  };
}

export async function exampleTransactions() {
  const [author, post] = await db.$transaction([
    (tx) =>
      tx.users.create({
        data: { email: "author@transaction.example", name: "Tx Author" },
      }),
    (tx) =>
      tx.posts.create({
        data: {
          title: "Transactional post",
          body: "Created via batch transaction",
          published: true,
          status: "published",
          price: "4.99",
          metadata: { source: "transaction" },
          author: { connect: { id: "user_1" } },
        },
      }),
  ]);

  await db.$transaction(async (tx) => {
    const user = await tx.users.create({
      data: { email: "rollback@transaction.example", name: "Rollback" },
    });

    await tx.posts.create({
      data: {
        title: "Should roll back",
        body: "This write is rolled back with the user",
        published: false,
        status: "draft",
        metadata: { rollback: true },
        author: { connect: { id: user["id"] as string } },
      },
    });

    throw new Error("intentional rollback");
  }).catch(() => undefined);

  await db.$transaction(async (tx) => {
    await tx.users.create({
      data: { email: "savepoint-outer@transaction.example", name: "Savepoint Outer" },
    });

    await tx
      .$transaction(async (nested) => {
        await nested.users.create({
          data: { email: "savepoint-inner@transaction.example", name: "Savepoint Inner" },
        });
        throw new Error("intentional nested rollback");
      })
      .catch(() => undefined);
  });

  return { author, post };
}
