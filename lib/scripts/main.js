import { world, system } from "@minecraft/server";
// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const CONTAINER_CHECK_INTERVAL = 10; // ticks (~0.5 seconds)
const INTERACT_RANGE_SQ = 49; // 7 blocks squared
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
    startTrackingContainer(player, block, 0);
});
function startTrackingContainer(player, block, attempt) {
    const state = getBlockContainerState(block);
    if (!state) {
        // Retry for blocks that need time to open (e.g., shulker boxes)
        if (attempt < 3) {
            const loc = toTrackedBlock(block.location);
            const dimId = block.dimension.id;
            system.runTimeout(() => {
                try {
                    const b = world.getDimension(dimId).getBlock(loc);
                    if (b && isContainerBlock(b.typeId))
                        startTrackingContainer(player, b, attempt + 1);
                }
                catch ( /* player or block may be invalid */_a) { /* player or block may be invalid */ }
            }, 5);
        }
        return;
    }
    const prev = openContainers.get(player.id);
    const sameBlock = prev &&
        prev.dimensionId === block.dimension.id &&
        prev.groupKey === state.groupKey;
    if (!sameBlock) {
        // Player opened a DIFFERENT container — sort & close the previous one first
        const old = openContainers.get(player.id);
        if (old) {
            sortTrackedContainer(old);
            openContainers.delete(player.id);
        }
    }
    openContainers.set(player.id, {
        blocks: state.blocks,
        groupKey: state.groupKey,
        dimensionId: block.dimension.id,
        snapshot: state.snapshot,
    });
    console.warn(`[autosort] tracking container ${state.groupKey} for ${player.name}`);
}
// ── Live-sort player inventory after inventory changes ─────────
world.afterEvents.playerInventoryItemChange.subscribe(({ player }) => {
    queueInventorySort(player);
});
// ── Periodic: only check distance for guaranteed UI close ─────
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const tracked = openContainers.get(player.id);
        if (!tracked)
            continue;
        const far = player.dimension.id !== tracked.dimensionId ||
            distanceSqToTrackedBlocks(player.location, tracked.blocks) > INTERACT_RANGE_SQ;
        if (far) {
            console.warn(`[autosort] closing (walked away) for ${player.name}`);
            sortTrackedContainer(tracked);
            openContainers.delete(player.id);
        }
    }
}, CONTAINER_CHECK_INTERVAL);
// ── Cleanup on leave ───────────────────────────────────────────
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
    const tracked = openContainers.get(playerId);
    if (tracked) {
        sortTrackedContainer(tracked);
        openContainers.delete(playerId);
    }
});
function sortTrackedContainer(tracked) {
    try {
        const state = getTrackedContainerState(tracked);
        if (!state) {
            console.warn(`[autosort] container no longer valid, skipping sort`);
            return;
        }
        if (state.snapshot !== tracked.snapshot) {
            sortContainerTargets(state.targets);
            console.warn(`[autosort] sorted container ${tracked.groupKey}`);
        }
        else {
            console.warn(`[autosort] no changes detected, skipping sort`);
        }
    }
    catch (e) {
        console.warn(`[autosort] sort error: ${e}`);
    }
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
// ── Sort helpers ───────────────────────────────────────────────
function getBlockContainer(block) {
    const inv = block.getComponent("inventory");
    return inv === null || inv === void 0 ? void 0 : inv.container;
}
function getBlockContainerState(block) {
    const targets = resolveContainerTargets(block);
    if (!targets)
        return undefined;
    return Object.assign({ targets, blocks: targets.map(({ block: targetBlock }) => toTrackedBlock(targetBlock.location)), groupKey: getContainerGroupKey(targets) }, getContainerStateFromTargets(targets));
}
function getTrackedContainerState(tracked) {
    try {
        const dim = world.getDimension(tracked.dimensionId);
        const block = dim.getBlock(tracked.blocks[0]);
        if (!block)
            return undefined;
        return getBlockContainerState(block);
    }
    catch (_a) {
        return undefined;
    }
}
function resolveContainerTargets(block) {
    const primary = getBlockContainer(block);
    if (!primary)
        return undefined;
    // Double chests disabled — each chest half sorts independently
    return [{ block, container: primary }];
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
function compareContainerTargets(left, right) {
    return compareTrackedBlocks(left.block.location, right.block.location);
}
function compareTrackedBlocks(left, right) {
    return left.x - right.x || left.y - right.y || left.z - right.z;
}
function toTrackedBlock(location) {
    return {
        x: location.x,
        y: location.y,
        z: location.z,
    };
}
function getContainerGroupKey(targets) {
    return targets
        .map(({ block }) => `${block.location.x},${block.location.y},${block.location.z}`)
        .join("|");
}
function getContainerStateFromTargets(targets) {
    var _a;
    let itemTotal = 0;
    const snapshot = [];
    for (const { container } of targets) {
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item) {
                snapshot.push("_");
                continue;
            }
            itemTotal += item.amount;
            snapshot.push(`${item.typeId}:${item.amount}:${(_a = item.nameTag) !== null && _a !== void 0 ? _a : ""}`);
        }
    }
    return {
        itemTotal,
        snapshot: snapshot.join("|"),
    };
}
function sortContainerTargets(targets) {
    var _a;
    const items = [];
    for (const { container } of targets) {
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (item)
                items.push(item.clone());
        }
    }
    if (items.length === 0)
        return;
    const merged = mergeStacks(items);
    merged.sort((a, b) => a.typeId.localeCompare(b.typeId) || b.amount - a.amount);
    let mergedIndex = 0;
    for (const { container } of targets) {
        for (let i = 0; i < container.size; i++) {
            container.setItem(i, (_a = merged[mergedIndex]) !== null && _a !== void 0 ? _a : undefined);
            mergedIndex += 1;
        }
    }
}
function hasTrackedBlock(blocks, location) {
    return blocks.some((block) => block.x === location.x && block.y === location.y && block.z === location.z);
}
function distanceSqToTrackedBlocks(location, blocks) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const block of blocks) {
        bestDistance = Math.min(bestDistance, distanceSq(location, block));
    }
    return bestDistance;
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