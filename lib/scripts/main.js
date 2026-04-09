import { world, system } from "@minecraft/server";
// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const CONTAINER_CHECK_INTERVAL = 4; // ticks (~0.2 seconds)
const INTERACT_RANGE_SQ = 49; // 7 blocks squared
const CONTAINER_FALLBACK_FINALIZE_TICKS = 100; // sort after ~5 seconds even if close cannot be inferred
const INVENTORY_SORT_DELAY_TICKS = 2; // small debounce for live inventory sorting
const openContainers = new Map();
const inventorySortTokens = new Map();
const inventorySortInProgress = new Set();
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
    if (isUnsupportedDoubleChest(block))
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
        finalizeContainer(player.id);
    }
    openContainers.set(player.id, {
        x: block.location.x,
        y: block.location.y,
        z: block.location.z,
        dimensionId: block.dimension.id,
        itemTotal: state.itemTotal,
        snapshot: state.snapshot,
        pendingSort: false,
        unchangedTicks: 0,
    });
});
// ── Live-sort player inventory after inventory changes ─────────
world.afterEvents.playerInventoryItemChange.subscribe(({ player }) => {
    queueInventorySort(player);
});
// ── Periodic: monitor open containers for insert changes and close detection
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const tracked = openContainers.get(player.id);
        if (!tracked)
            continue;
        const far = player.dimension.id !== tracked.dimensionId ||
            distanceSq(player.location, tracked) > INTERACT_RANGE_SQ;
        if (far) {
            finalizeContainer(player.id);
            continue;
        }
        const state = getTrackedContainerState(tracked);
        if (!state) {
            finalizeContainer(player.id);
            continue;
        }
        if (state.snapshot !== tracked.snapshot) {
            const insertedItems = state.itemTotal > tracked.itemTotal;
            tracked.itemTotal = state.itemTotal;
            tracked.snapshot = state.snapshot;
            tracked.pendingSort = tracked.pendingSort || insertedItems;
            tracked.unchangedTicks = 0;
            continue;
        }
        tracked.unchangedTicks += CONTAINER_CHECK_INTERVAL;
        const stoppedTargeting = !isTrackingBlockInView(player, tracked);
        if (!tracked.pendingSort && (stoppedTargeting || tracked.unchangedTicks >= CONTAINER_FALLBACK_FINALIZE_TICKS)) {
            stopTrackingContainer(player.id);
            continue;
        }
        if (tracked.pendingSort && (stoppedTargeting || tracked.unchangedTicks >= CONTAINER_FALLBACK_FINALIZE_TICKS)) {
            finalizeContainer(player.id);
        }
    }
}, CONTAINER_CHECK_INTERVAL);
// ── Cleanup on leave ───────────────────────────────────────────
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
    finalizeContainer(playerId);
});
function stopTrackingContainer(playerId) {
    openContainers.delete(playerId);
}
// ── Finalize a tracked container and sort once after interaction
function finalizeContainer(playerId) {
    const tracked = openContainers.get(playerId);
    if (!tracked)
        return;
    openContainers.delete(playerId);
    if (!tracked.pendingSort)
        return;
    const state = getTrackedContainerState(tracked);
    if (!state)
        return;
    sortContainer(state.container, 0);
}
function queueInventorySort(player) {
    var _a;
    if (openContainers.has(player.id))
        return;
    if (inventorySortInProgress.has(player.id))
        return;
    const token = ((_a = inventorySortTokens.get(player.id)) !== null && _a !== void 0 ? _a : 0) + 1;
    inventorySortTokens.set(player.id, token);
    system.runTimeout(() => {
        if (inventorySortTokens.get(player.id) !== token)
            return;
        if (openContainers.has(player.id))
            return;
        try {
            inventorySortInProgress.add(player.id);
            sortContainer(player.getComponent("inventory").container, HOTBAR_SIZE);
        }
        catch (_a) {
            // player may be invalid during respawn, dimension changes, or logout
        }
        finally {
            inventorySortInProgress.delete(player.id);
        }
    }, INVENTORY_SORT_DELAY_TICKS);
}
function isTrackingBlockInView(player, tracked) {
    try {
        const hit = player.getBlockFromViewDirection({
            maxDistance: Math.sqrt(INTERACT_RANGE_SQ),
            includeLiquidBlocks: false,
            includePassableBlocks: true,
        });
        const block = hit === null || hit === void 0 ? void 0 : hit.block;
        return !!block &&
            block.dimension.id === tracked.dimensionId &&
            block.location.x === tracked.x &&
            block.location.y === tracked.y &&
            block.location.z === tracked.z;
    }
    catch (_a) {
        return false;
    }
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
function getPairedChestBlock(block) {
    if (!isPairableChestBlock(block.typeId))
        return undefined;
    const facing = block.permutation.getState("minecraft:cardinal_direction");
    for (const adjacent of getHorizontalNeighbors(block)) {
        if (!adjacent)
            continue;
        if (adjacent.typeId !== block.typeId)
            continue;
        if (adjacent.permutation.getState("minecraft:cardinal_direction") !== facing)
            continue;
        if (!getBlockContainer(adjacent))
            continue;
        return adjacent;
    }
    return undefined;
}
function isPairableChestBlock(typeId) {
    return typeId === "minecraft:chest" || typeId === "minecraft:trapped_chest";
}
function getHorizontalNeighbors(block) {
    return [block.north(), block.south(), block.east(), block.west()];
}
function isUnsupportedDoubleChest(block) {
    return !!getPairedChestBlock(block);
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