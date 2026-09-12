import { defineSchema, id, manyToMany, table, text } from "neoorm/schema";
import type {
	ColumnNames,
	RelationWhereMap,
} from "../src/schema/relation-types.js";
import type {
	InferInsertRow,
	InferSelectRow,
	RelationCreateMap,
	RelationUpdateMap,
	WhereInput,
} from "../src/schema/types.js";
import type { RelationAccessors } from "../src/schema/types.js";

const users = table({
	id: id(),
	email: text().notNull(),
});

const servers = table({
	id: id(),
	name: text().notNull(),
	members: manyToMany("users"),
});

const guilds = table({
	id: id(),
	officers: manyToMany("users", { as: "mods", inverse: "guildsLed" }),
});

export const schema = defineSchema({ users, servers, guilds });

type S = typeof schema._tables;
type ServersColumns = S["servers"]["_columns"];

type Expect<T extends true> = T;
type NotIn<T, U> = T extends U ? false : true;

// The virtual m2m column is excluded from scalar column surfaces.
type AssertScalarExcluded = Expect<
	NotIn<
		| ColumnNames<ServersColumns>
		| keyof InferSelectRow<ServersColumns>
		| keyof InferInsertRow<ServersColumns>,
		"members"
	>
>;
declare const scalarExcluded: AssertScalarExcluded;
void scalarExcluded;

// Forward relation: servers.members -> users.
type ServerAccessors = RelationAccessors<S, "servers">;
declare const serverTarget: NonNullable<ServerAccessors["members"]>;
const serverTargetOk: "users" = serverTarget;
void serverTargetOk;

// Inverse relation: users.servers -> servers (defaults to source accessor).
type UserAccessors = RelationAccessors<S, "users">;
declare const userTarget: NonNullable<UserAccessors["servers"]>;
const userTargetOk: "servers" = userTarget;
void userTargetOk;

// as/inverse overrides are reflected at the type level.
declare const modsTarget: NonNullable<RelationAccessors<S, "guilds">["mods"]>;
const modsTargetOk: "users" = modsTarget;
void modsTargetOk;
declare const guildsLedTarget: NonNullable<
	RelationAccessors<S, "users">["guildsLed"]
>;
const guildsLedTargetOk: "guilds" = guildsLedTarget;
void guildsLedTargetOk;

// m2m relations appear in where filters (forward and inverse).
const whereForward = {
	members: { some: { email: "x@y.z" } },
} satisfies WhereInput<ServersColumns, S, "servers">;
void whereForward;

const whereInverse = {
	servers: { none: { name: "dark" } },
} satisfies WhereInput<S["users"]["_columns"], S, "users">;
void whereInverse;

type ServerWhereMap = RelationWhereMap<S, "servers">;
declare const whereShape: NonNullable<ServerWhereMap["members"]>;
const whereShapeOk: {
	some?: { email?: unknown };
} = whereShape;
void whereShapeOk;

// m2m relations accept connect/disconnect/set/delete/create writes.
declare const createShape: NonNullable<RelationCreateMap<S, "servers">["members"]>;
const createShapeOk: {
	connect?: unknown;
	disconnect?: unknown;
	set?: unknown;
	delete?: unknown;
	connectOrCreate?: unknown;
} = createShape;
void createShapeOk;

type ServerUpdateMap = RelationUpdateMap<S, "servers">;
declare const updateShape: NonNullable<ServerUpdateMap["members"]>;
const updateShapeOk: {
	connect?: unknown;
	disconnect?: unknown;
	set?: unknown;
	delete?: unknown;
} = updateShape;
void updateShapeOk;

declare const inverseWriteShape: NonNullable<
	RelationCreateMap<S, "users">["servers"]
>;
const inverseWriteShapeOk: {
	connect?: unknown;
	set?: unknown;
} = inverseWriteShape;
void inverseWriteShapeOk;