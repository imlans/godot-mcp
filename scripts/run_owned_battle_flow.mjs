import { withOwnedMcpSession } from "./owned-session-lib.mjs";

try {
	const report = await withOwnedMcpSession(async (session) => {
		const started = await session.execIngame(
			"start_new_game",
			{ class_id: "class_warrior" },
		);
		if (started?.success !== true) {
			throw new Error(`START_NEW_GAME_FAILED:${JSON.stringify(started)}`);
		}
		await session.assertOwnership();

		const floor = await waitForValue(
			() => session.execIngame("get_floor_info", {}),
			(value) => Array.isArray(value?.rooms),
		);
		const room = floor.rooms.find((candidate) => (
			candidate?.can_enter === true
			&& (
				String(candidate.room_type).includes("战斗")
				|| String(candidate.room_type).includes("Boss")
			)
		));
		if (!room) {
			throw new Error("NO_ENTERABLE_BATTLE_ROOM");
		}
		const entering = await session.execIngame(
			"try_enter_room",
			{ room_id: room.room_id },
		);
		if (entering?.success !== true) {
			throw new Error(`ENTER_ROOM_FAILED:${JSON.stringify(entering)}`);
		}

		const battle = await waitForValue(
			async () => {
				await session.assertOwnership();
				return session.execIngame("get_battle_state", {});
			},
			(value) => (
				value !== null
				&& typeof value === "object"
				&& value.battle_state_value === 0
				&& Array.isArray(value.entities)
			),
			30000,
		);
		const player = battle.entities.find((entity) => entity.faction === "player");
		const liveTargets = battle.entities.filter(
			(entity) => entity.faction === "enemy" && entity.alive && entity.entity_ref,
		);
		if (!player?.entity_ref || liveTargets.length === 0) {
			throw new Error("BATTLE_ROSTER_MISSING_PLAYER_OR_ENEMY");
		}

		const movementDispatch = await dispatchPlayerCellClick(
			session,
			liveTargets,
		);
		const target = liveTargets.find(
			(candidate) => (
				candidate.entity_ref.entity_id === movementDispatch.target_entity_id
			),
		);
		if (!target) {
			throw new Error(
				`PLAYER_CLICK_TARGET_REF_MISMATCH:${JSON.stringify(movementDispatch)}`,
			);
		}
		const hpBefore = await session.execIngame("get_enemy_hp", {});
		const targetBefore = hpBefore.enemies?.find(
			(enemy) => enemy.entity_ref?.entity_id === target.entity_ref.entity_id,
		);
		if (!targetBefore) {
			throw new Error("TARGET_HP_PROJECTION_MISSING");
		}
		const movedBattle = await waitForValue(
			() => session.execIngame("get_battle_state", {}),
			(value) => {
				const currentPlayer = value?.entities?.find(
					(entity) => entity.entity_ref?.entity_id === player.entity_ref.entity_id,
				);
				return (
					currentPlayer?.grid_position?.x === movementDispatch.target_x
					&& currentPlayer?.grid_position?.y === movementDispatch.target_y
				);
			},
			30000,
		);
		const movedPlayer = movedBattle.entities.find(
			(entity) => entity.entity_ref?.entity_id === player.entity_ref.entity_id,
		);
		const movementState = await readPlayerMovementState(session);
		if (movementState.has_move !== false) {
			throw new Error(
				`PLAYER_MOVE_RESOURCE_NOT_CONSUMED:${JSON.stringify(movementState)}`,
			);
		}

		const attack = await session.execIngame(
			"play_card",
			{ card_index: 0, target_ref: target.entity_ref },
		);
		if (attack?.success !== true) {
			throw new Error(`PLAYER_ATTACK_FAILED:${JSON.stringify(attack)}`);
		}
		const hpAfter = await waitForValue(
			() => session.execIngame("get_enemy_hp", {}),
			(value) => {
				const row = value?.enemies?.find(
					(enemy) => enemy.entity_ref?.entity_id === target.entity_ref.entity_id,
				);
				return row && row.current_hp < targetBefore.current_hp;
			},
		);
		const targetAfter = hpAfter.enemies.find(
			(enemy) => enemy.entity_ref?.entity_id === target.entity_ref.entity_id,
		);

		const stateBeforeEnd = await session.execIngame("get_battle_state", {});
		if (stateBeforeEnd?.battle_state_value !== 0) {
			throw new Error("PLAYER_TURN_NOT_READY_FOR_END_TURN");
		}
		const endReceipt = await session.execIngame("end_turn", {}, 60000);
		if (
			endReceipt?.success !== true
			|| endReceipt?.transition_completed !== true
			|| endReceipt?.round_after <= endReceipt?.round_before
			|| ![0, 2].includes(endReceipt?.state_after)
		) {
			throw new Error(`END_TURN_NOT_COMPLETED:${JSON.stringify(endReceipt)}`);
		}
		await session.assertOwnership();
		return {
			roomId: room.room_id,
			playerRef: player.entity_ref,
			targetRef: target.entity_ref,
			movement: {
				entry: "cell_interaction_controller",
				inputBoundary: "grid_cell_click",
				from: player.grid_position,
				to: movedPlayer.grid_position,
				route: movementDispatch.route,
				hasMoveAfter: movementState.has_move,
			},
			targetHpBefore: targetBefore.current_hp,
			targetHpAfter: targetAfter.current_hp,
			attack,
			endReceipt,
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


async function dispatchPlayerCellClick(session, liveTargets) {
	const enemyCandidates = liveTargets.map((target) => ({
		entity_id: target.entity_ref.entity_id,
		x: target.grid_position.x,
		y: target.grid_position.y,
	}));
	const encodedCandidates = JSON.stringify(JSON.stringify(enemyCandidates));
	const code = [
		"var battle = scene_tree.current_scene",
		"battle._show_default_move_range()",
		"var player = battle.player_unit",
		"var selection = battle.selection_state",
		`var enemy_candidates: Array = JSON.parse_string(${encodedCandidates})`,
		"var destination = Vector2i(-1, -1)",
		"var selected_enemy: Dictionary = {}",
		"for enemy_candidate_variant in enemy_candidates:",
		"\tvar enemy_candidate: Dictionary = enemy_candidate_variant",
		"\tvar enemy_pos := Vector2i(int(enemy_candidate.x), int(enemy_candidate.y))",
		"\tfor candidate_variant in selection.cached_paths.keys():",
		"\t\tvar candidate: Vector2i = candidate_variant",
		"\t\tif candidate == player.grid_position:",
		"\t\t\tcontinue",
		"\t\tvar cell: Dictionary = battle.grid_system.get_cell(candidate)",
		"\t\tif cell.get(\"unit\") != null:",
		"\t\t\tcontinue",
		"\t\tif absi(candidate.x - enemy_pos.x) + absi(candidate.y - enemy_pos.y) == 1:",
		"\t\t\tdestination = candidate",
		"\t\t\tselected_enemy = enemy_candidate",
		"\t\t\tbreak",
		"\tif destination != Vector2i(-1, -1):",
		"\t\tbreak",
		"if destination == Vector2i(-1, -1):",
		"\tvar cached_destinations: Array = []",
		"\tfor candidate_variant in selection.cached_paths.keys():",
		"\t\tvar candidate: Vector2i = candidate_variant",
		"\t\tcached_destinations.append({\"x\": candidate.x, \"y\": candidate.y})",
		"\treturn JSON.stringify({",
		"\t\t\"success\": false,",
		"\t\t\"reason_code\": \"no_ui_reachable_attack_setup\",",
		"\t\t\"player_position\": {\"x\": player.grid_position.x, \"y\": player.grid_position.y},",
		"\t\t\"enemy_candidates\": enemy_candidates,",
		"\t\t\"player_has_move\": player.has_move,",
		"\t\t\"cached_destinations\": cached_destinations,",
		"\t})",
		"var route: Array = selection.cached_paths.get(destination, [])",
		"if route.is_empty() or route[0] != player.grid_position or route[-1] != destination:",
		"\treturn JSON.stringify({\"success\": false, \"reason_code\": \"ui_route_not_canonical\", \"route\": route})",
		"battle.cell_interaction_controller.call_deferred(\"_on_cell_clicked\", destination)",
		"return JSON.stringify({",
		"\t\"success\": true,",
		"\t\"target_x\": destination.x,",
		"\t\"target_y\": destination.y,",
		"\t\"target_entity_id\": selected_enemy.entity_id,",
		"\t\"route\": route,",
		"})",
	].join("\n");
	const envelope = await session.execIngame("run_script", { code });
	if (envelope?.success !== true || typeof envelope?.result !== "string") {
		throw new Error(`PLAYER_CLICK_DISPATCH_FAILED:${JSON.stringify(envelope)}`);
	}
	let receipt;
	try {
		receipt = JSON.parse(envelope.result);
	} catch {
		throw new Error(`PLAYER_CLICK_RECEIPT_INVALID:${JSON.stringify(envelope)}`);
	}
	if (receipt?.success !== true) {
		throw new Error(`PLAYER_CLICK_REJECTED:${JSON.stringify(receipt)}`);
	}
	return receipt;
}


async function readPlayerMovementState(session) {
	const envelope = await session.execIngame("run_script", {
		code: [
			"var battle = scene_tree.current_scene",
			"return JSON.stringify({",
			"\t\"position_x\": battle.player_unit.grid_position.x,",
			"\t\"position_y\": battle.player_unit.grid_position.y,",
			"\t\"has_move\": battle.player_unit.has_move,",
			"})",
		].join("\n"),
	});
	if (envelope?.success !== true || typeof envelope?.result !== "string") {
		throw new Error(`PLAYER_MOVE_STATE_MISSING:${JSON.stringify(envelope)}`);
	}
	return JSON.parse(envelope.result);
}


async function waitForValue(read, accept, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		try {
			lastValue = await read();
			if (accept(lastValue)) {
				return lastValue;
			}
		} catch {
			// 场景切换期间 transport 可短暂重连；会话 PID 门由调用者单独验证。
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	throw new Error(`WAIT_FOR_GAME_STATE_TIMEOUT:${JSON.stringify(lastValue)}`);
}
