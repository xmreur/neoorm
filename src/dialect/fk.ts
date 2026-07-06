export type FkTargetParts = {
	tableSql: string;
	columnSql: string;
};

export function parseFkTarget(target: string): FkTargetParts {
	const dotIndex = target.indexOf(".");
	if (dotIndex <= 0 || dotIndex === target.length - 1) {
		throw new Error(`Invalid foreign key target "${target}"`);
	}
	const tableSql = target.slice(0, dotIndex);
	const columnSql = target.slice(dotIndex + 1);
	if (!tableSql || !columnSql) {
		throw new Error(`Invalid foreign key target "${target}"`);
	}
	return { tableSql, columnSql };
}
