export type SqlFragment = {
	readonly _kind: "fragment";
	readonly text: string;
	readonly params: readonly unknown[];
};

export type SqlValue = unknown | SqlFragment;

export function sqlFragment(text: string, params: unknown[] = []): SqlFragment {
	return { _kind: "fragment", text, params };
}

export function isSqlFragment(value: unknown): value is SqlFragment {
	return (
		typeof value === "object" &&
		value !== null &&
		"_kind" in value &&
		(value as SqlFragment)._kind === "fragment"
	);
}

export function sqlTag(
	strings: TemplateStringsArray,
	...values: unknown[]
): SqlFragment {
	let text = "";
	const params: unknown[] = [];
	let paramIndex = 0;

	for (let i = 0; i < strings.length; i++) {
		text += strings[i];
		if (i < values.length) {
			const value = values[i];
			if (isSqlFragment(value)) {
				const fragmentParams = [...value.params];
				const adjusted = value.text.replace(
					/\$(\d+)/g,
					(_, n: string) => {
						return `$${paramIndex + Number(n)}`;
					},
				);
				text += adjusted;
				params.push(...fragmentParams);
				paramIndex += fragmentParams.length;
			} else {
				paramIndex++;
				params.push(value);
				text += `$${paramIndex}`;
			}
		}
	}

	return sqlFragment(text, params);
}

export function sqlId(name: string): SqlFragment {
	const escaped = `"${name.replace(/"/g, '""')}"`;
	return sqlFragment(escaped, []);
}

export type CompiledSql = {
	text: string;
	params: unknown[];
};

export function compile(fragment: SqlFragment): CompiledSql {
	return { text: fragment.text, params: [...fragment.params] };
}
