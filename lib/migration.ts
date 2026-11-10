/** Schema 1 is the existing Upkeep file layout. The host has already staged a copy. */
export function validateMigration(fromSchema: number | null, toSchema: number): void {
	if (toSchema !== 1 || (fromSchema !== null && fromSchema !== 1)) {
		throw new Error(`Unsupported Upkeep data migration ${fromSchema} → ${toSchema}`);
	}
}
