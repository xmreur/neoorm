import { describe, expect, it } from "vitest";
import { singularTypeName } from "../src/codegen/manifest-relations.js";

describe("singularTypeName", () => {
	it("singularizes regular plurals", () => {
		expect(singularTypeName("users")).toBe("User");
		expect(singularTypeName("posts")).toBe("Post");
		expect(singularTypeName("tags")).toBe("Tag");
	});

	it("keeps already-singular words ending in s intact", () => {
		expect(singularTypeName("status")).toBe("Status");
		expect(singularTypeName("news")).toBe("News");
		expect(singularTypeName("class")).toBe("Class");
		expect(singularTypeName("address")).toBe("Address");
		expect(singularTypeName("bonus")).toBe("Bonus");
		expect(singularTypeName("analysis")).toBe("Analysis");
		expect(singularTypeName("series")).toBe("Series");
		expect(singularTypeName("species")).toBe("Species");
	});

	it("keeps non-s words unchanged", () => {
		expect(singularTypeName("profile")).toBe("Profile");
		expect(singularTypeName("category")).toBe("Category");
	});
});