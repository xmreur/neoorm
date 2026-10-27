/** Keys that change an object's prototype when assigned. */
export function isUnsafeOwnKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}
