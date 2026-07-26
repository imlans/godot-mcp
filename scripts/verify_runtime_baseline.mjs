import { withOwnedMcpSession } from "./owned-session-lib.mjs";

try {
	const report = await withOwnedMcpSession(async (session, baselineState) => {
		await session.assertOwnership();
		return {
			connected: true,
			structuredState: true,
			currentState: baselineState.current_state_name,
		};
	});
	process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
	process.stderr.write(`${JSON.stringify({
		success: false,
		error: error instanceof Error ? error.message : String(error),
	})}\n`);
	process.exitCode = 1;
}
