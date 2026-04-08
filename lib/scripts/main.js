import { world, system } from "@minecraft/server";
// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const SORT_INTERVAL = 40; // ticks (~2 seconds)
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
    const prev = openContainers.get(player.id);
    // Same container reopened — skip sort, just keep tracking
    const sameBlock = prev &&
        prev.dimensionId === block.dimension.id &&
        prev.x === block.location.x &&
        prev.y === block.location.y &&
        prev.z === block.location.z;
    if (!sameBlock) {
        // Different container — finalize (sort) the old one
        finalizeContainer(player.id);
    }
    openContainers.set(player.id, {
        x: block.location.x,
        y: block.location.y,
        z: block.location.z,
        dimensionId: block.dimension.id,
    });
});
// ── Periodic: auto-sort player inventory + detect container close
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const tracked = openContainers.get(player.id);
        // Only sort player inventory when no container is open
        if (!tracked) {
            try {
                sortContainer(player.getComponent("inventory").container, HOTBAR_SIZE);
            }
            catch (_a) {
                // player in invalid state (loading, dead, etc.)
            }
            continue;
        }
        // Detect container close: player walked away
        const far = player.dimension.id !== tracked.dimensionId ||
            distanceSq(player.location, tracked) > INTERACT_RANGE_SQ;
        if (far)
            finalizeContainer(player.id);
    }
}, SORT_INTERVAL);
// ── Cleanup on leave ───────────────────────────────────────────
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
    finalizeContainer(playerId);
});
// ── Finalize (sort on close) a tracked container ───────────────
function finalizeContainer(playerId) {
    const tracked = openContainers.get(playerId);
    if (!tracked)
        return;
    openContainers.delete(playerId);
    try {
        const dim = world.getDimension(tracked.dimensionId);
        const block = dim.getBlock(tracked);
        if (block)
            sortBlockContainer(block);
    }
    catch (_a) {
        // chunk unloaded or block gone
    }
}
// ── Sort helpers ───────────────────────────────────────────────
function sortBlockContainer(block) {
    const inv = block.getComponent("inventory");
    if (inv === null || inv === void 0 ? void 0 : inv.container)
        sortContainer(inv.container, 0);
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