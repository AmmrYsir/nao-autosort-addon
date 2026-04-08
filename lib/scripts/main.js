import { world, system } from "@minecraft/server";
// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const PLAYER_SORT_INTERVAL = 40; // ticks (~2 seconds)
const CONTAINER_CHECK_INTERVAL = 4; // ticks (~0.2 seconds)
const CONTAINER_IDLE_DELAY_TICKS = 20; // wait ~1 second after the last change before sorting
const INTERACT_RANGE_SQ = 49; // 7 blocks squared
const openContainers = new Map();
function isContainerBlock(typeId) {
    return (typeId === "minecraft:chest" ||
        typeId === "minecraft:trapped_chest" ||
        typeId === "minecraft:barrel" ||
        typeId.endsWith("shulker_box"));
}
// ── Container open: track for close-sort ───────────────────────
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block, isFirstEvent }) => {
    if (!isFirstEvent)
        return;
    if (!isContainerBlock(block.typeId))
        return;
    const state = getBlockContainerState(block);
    if (!state)
        return;
    const prev = openContainers.get(player.id);
    const sameBlock = prev &&
        prev.dimensionId === block.dimension.id &&
        prev.x === block.location.x &&
        prev.y === block.location.y &&
        prev.z === block.location.z;
    if (!sameBlock) {
        stopTrackingContainer(player.id);
    }
    openContainers.set(player.id, {
        x: block.location.x,
        y: block.location.y,
        z: block.location.z,
        dimensionId: block.dimension.id,
        itemTotal: state.itemTotal,
        snapshot: state.snapshot,
        pendingSort: false,
        idleTicks: 0,
    });
});
// ── Periodic: auto-sort player inventory ───────────────────────
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        if (openContainers.has(player.id))
            continue;
        try {
            sortContainer(player.getComponent("inventory").container, HOTBAR_SIZE);
        }
        catch (_a) {
            // player in invalid state (loading, dead, etc.)
        }
    }
}, PLAYER_SORT_INTERVAL);
// ── Periodic: monitor open containers for insert-triggered sort ─
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const tracked = openContainers.get(player.id);
        if (!tracked)
            continue;
        const far = player.dimension.id !== tracked.dimensionId ||
            distanceSq(player.location, tracked) > INTERACT_RANGE_SQ;
        if (far) {
            stopTrackingContainer(player.id);
            continue;
        }
        const state = getTrackedContainerState(tracked);
        if (!state) {
            stopTrackingContainer(player.id);
            continue;
        }
        if (state.snapshot !== tracked.snapshot) {
            tracked.itemTotal = state.itemTotal;
            tracked.snapshot = state.snapshot;
            tracked.pendingSort = true;
            tracked.idleTicks = 0;
            continue;
        }
        if (!tracked.pendingSort) {
            continue;
        }
        tracked.idleTicks += CONTAINER_CHECK_INTERVAL;
        if (tracked.idleTicks < CONTAINER_IDLE_DELAY_TICKS)
            continue;
        sortContainer(state.container, 0);
        const sortedState = getContainerState(state.container);
        tracked.itemTotal = sortedState.itemTotal;
        tracked.snapshot = sortedState.snapshot;
        tracked.pendingSort = false;
        tracked.idleTicks = 0;
    }
}, CONTAINER_CHECK_INTERVAL);
// ── Cleanup on leave ───────────────────────────────────────────
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
    stopTrackingContainer(playerId);
});
// ── Stop tracking a container without sorting it ───────────────
function stopTrackingContainer(playerId) {
    openContainers.delete(playerId);
}
// ── Sort helpers ───────────────────────────────────────────────
function getBlockContainer(block) {
    const inv = block.getComponent("inventory");
    return inv === null || inv === void 0 ? void 0 : inv.container;
}
function getBlockContainerState(block) {
    const container = getBlockContainer(block);
    if (!container)
        return undefined;
    return Object.assign({ container }, getContainerState(container));
}
function getTrackedContainerState(tracked) {
    try {
        const dim = world.getDimension(tracked.dimensionId);
        const block = dim.getBlock(tracked);
        if (!block)
            return undefined;
        return getBlockContainerState(block);
    }
    catch (_a) {
        return undefined;
    }
}
function getContainerState(container) {
    var _a;
    let itemTotal = 0;
    const snapshot = [];
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (!item) {
            snapshot.push("_");
            continue;
        }
        itemTotal += item.amount;
        snapshot.push(`${item.typeId}:${item.amount}:${(_a = item.nameTag) !== null && _a !== void 0 ? _a : ""}`);
    }
    return {
        itemTotal,
        snapshot: snapshot.join("|"),
    };
}
function sortContainer(container, startSlot) {
    var _a;
    const size = container.size;
    const items = [];
    for (let i = startSlot; i < size; i++) {
        const item = container.getItem(i);
        if (item)
            items.push(item.clone());
    }
    if (items.length === 0)
        return;
    const merged = mergeStacks(items);
    merged.sort((a, b) => a.typeId.localeCompare(b.typeId) || b.amount - a.amount);
    for (let i = startSlot; i < size; i++) {
        container.setItem(i, (_a = merged[i - startSlot]) !== null && _a !== void 0 ? _a : undefined);
    }
}
function mergeStacks(items) {
    const result = [];
    for (const item of items) {
        let remaining = item.amount;
        for (const stack of result) {
            if (remaining <= 0)
                break;
            if (stack.isStackableWith(item) && stack.amount < stack.maxAmount) {
                const add = Math.min(remaining, stack.maxAmount - stack.amount);
                stack.amount += add;
                remaining -= add;
            }
        }
        while (remaining > 0) {
            const newStack = item.clone();
            newStack.amount = Math.min(remaining, item.maxAmount);
            result.push(newStack);
            remaining -= newStack.amount;
        }
    }
    return result;
}
function distanceSq(a, b) {
    return Math.pow((a.x - b.x), 2) + Math.pow((a.y - b.y), 2) + Math.pow((a.z - b.z), 2);
}
//# sourceMappingURL=main.js.map