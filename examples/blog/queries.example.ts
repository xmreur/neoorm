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
        }
      }
    },
  });

  const post = await db.posts.findFirst({
    where: {
      title: { contains: "ORM" },
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

  const newPost = await db.posts.create({
    data: {
      title: "NeoORM",
      body: "FK-first relations.",
      published: true,
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
      count(p.id) as post_count
    FROM users u
    LEFT JOIN posts p ON p.author_id = u.id
    GROUP BY u.id, u.email
    ORDER BY post_count DESC
  `;

  return { users, user, post, posts, newPost, rows };
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

  const deleted = await db.posts.delete({
    where: { title: "Draft post" },
  });

  const deletedCount = await db.comments.deleteMany({
    where: { postId: "post_1" },
  });

  const deletedUser = await db.users.deleteById("user_1");

  return { updated, updatedById, count, deleted, deletedCount, deletedUser };
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
        author: { connect: { id: user["id"] as string } },
      },
    });

    throw new Error("intentional rollback");
  }).catch(() => undefined);

  return { author, post };
}
