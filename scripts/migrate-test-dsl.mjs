import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			files.push(...walk(path));
		} else if (path.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

const files = walk("test");

for (const file of files) {
	let content = readFileSync(file, "utf8");
	const original = content;

	content = content.replace(
		/import\s*\{([^}]*)\}\s*from\s*["'](?:\.\.\/src\/schema\/many-to-many|neoorm\/schema)["'];?\n/g,
		(match, imports) => {
			const parts = imports
				.split(",")
				.map((p) => p.trim())
				.filter(
					(p) =>
						p &&
						p !== "getManyToManyRegistry" &&
						p !== "manyToMany",
				);
			if (parts.length === 0) return "";
			return `import { ${parts.join(", ")} } from "neoorm/schema";\n`;
		},
	);

	content = content.replace(
		/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/src\/schema\/many-to-many\.js["'];?\n/g,
		"",
	);

	content = content.replace(
		/function ensureBlogManyToManyRegistry\(\): void \{[\s\S]*?\}\n\n/g,
		"",
	);

	content = content.replace(/\s*ensureBlogManyToManyRegistry\(\);\n/g, "\n");

	content = content.replace(
		/manyToMany\(schema\.posts, schema\.tags, \{[\s\S]*?\}\);\n/g,
		"",
	);

	content = content.replace(
		/schemaToManifest\(([^,]+),\s*getManyToManyRegistry\(\)(?:,\s*([^)]+))?\)/g,
		"schemaToManifest($1$2 ? $2 : )",
	);

	content = content.replace(
		/schemaToManifest\(([^,]+),\s*getPluginRegistry\(\)(?:,\s*(\{[^}]+\}))?\)/g,
		"schemaToManifest($1, getPluginRegistry()$2 ? , $2 : )",
	);

	content = content.replace(
		/schemaToManifest\(([^,]+),\s*\[\],\s*(\{[^}]+\})\)/g,
		"schemaToManifest($1, $2)",
	);

	content = content.replace(
		/schemaToManifest\(([^,]+),\s*undefined,\s*(\{[^}]+\})\)/g,
		"schemaToManifest($1, $2)",
	);

	content = content.replace(
		/schemaToManifest\(([^,]+),\s*plugins,\s*(\{[^}]+\})\)/g,
		"schemaToManifest($1, plugins, $2)",
	);

	content = content.replace(/table\("([a-zA-Z0-9_]+)",\s*\{/g, "table({");

	content = content.replace(
		/fk\("([^"]+)",\s*\{\s*as:\s*"([^"]+)",\s*inverse:\s*"([^"]+)",?\s*\}\)/g,
		'fk("$1").as("$2").inverse("$3")',
	);

	content = content.replace(
		/fk\("([^"]+)",\s*\{\s*as:\s*"([^"]+)",?\s*\}\)/g,
		'fk("$1").as("$2")',
	);

	content = content.replace(
		/fk\("([^"]+)",\s*\{\s*inverse:\s*"([^"]+)",?\s*unique:\s*true,?\s*onDelete:\s*"([^"]+)",?\s*\}\)/g,
		'fk("$1").inverse("$2").unique().onDelete("$3")',
	);

	content = content.replace(
		/fk\("([^"]+)",\s*\{\s*inverse:\s*"([^"]+)",?\s*onDelete:\s*"([^"]+)",?\s*\}\)/g,
		'fk("$1").inverse("$2").onDelete("$3")',
	);

	content = content.replace(
		/fk\("([^"]+)",\s*\{\s*inverse:\s*"([^"]+)",?\s*\}\)/g,
		'fk("$1").inverse("$2")',
	);

	content = content.replace(
		/fk\("([^"]+)",\s*\{\s*onDelete:\s*"([^"]+)",?\s*\}\)/g,
		'fk("$1").onDelete("$2")',
	);

	content = content.replace(
		/\(t\)\s*=>\s*\(\{\s*([a-zA-Z0-9_]+):\s*(unique|index|primaryKey)\(([^)]*)\),?\s*\}\)/g,
		"(t) => [$2($3)]",
	);

	content = content.replace(
		/\(t\)\s*=>\s*\(\{\s*([a-zA-Z0-9_]+):\s*manyToMany\(([^)]*)\),?\s*\}\)/g,
		"",
	);

	if (content !== original) {
		writeFileSync(file, content);
		console.log("updated", file);
	}
}
