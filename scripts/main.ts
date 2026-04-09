import { world, system, Player, Block, Container, ItemStack } from "@minecraft/server";

// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const CONTAINER_CHECK_INTERVAL = 4; // ticks (~0.2 seconds)
const INTERACT_RANGE_SQ = 49; // 7 blocks squared
const CONTAINER_FALLBACK_FINALIZE_TICKS = 100; // sort after ~5 seconds even if close cannot be inferred
const INVENTORY_SORT_DELAY_TICKS = 2; // small debounce for live inventory sorting

// ── Track open containers per player ───────────────────────────
interface TrackedContainer {
  blocks: TrackedBlock[];
  groupKey: string;
  dimensionId: string;
  itemTotal: number;
  snapshot: string;
  pendingSort: boolean;
  unchangedTicks: number;
}

interface TrackedBlock {
  x: number;
  y: number;
  z: number;
}

interface ResolvedContainerGroup {
  blocks: TrackedBlock[];
  groupKey: string;
  targets: ContainerTarget[];
  itemTotal: number;
  snapshot: string;
}

interface ContainerTarget {
  block: Block;
  container: Container;
}

const openContainers = new Map<string, TrackedContainer>();
const inventorySortTokens = new Map<string, number>();
const inventorySortInProgress = new Set<string>();

function isContainerBlock(typeId: string): boolean {
  return (
    typeId === "minecraft:chest" ||
    typeId === "minecraft:trapped_chest" ||
    typeId === "minecraft:barrel" ||
    typeId.endsWith("shulker_box")
  );
}

// ── Container open: track for close-sort ───────────────────────
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block, isFirstEvent }) => {
  if (!isFirstEvent) return;
  if (!isContainerBlock(block.typeId)) return;

  const state = getBlockContainerState(block);
  if (!state) return;

  const prev = openContainers.get(player.id);

  const sameBlock =
    prev &&
    prev.dimensionId === block.dimension.id &&
    prev.groupKey === state.groupKey;

  if (!sameBlock) {
    finalizeContainer(player.id);
  }

  openContainers.set(player.id, {
    blocks: state.blocks,
    groupKey: state.groupKey,
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
    if (!tracked) continue;

    const far = player.dimension.id !== tracked.dimensionId || distanceSqToTrackedBlocks(player.location, tracked.blocks) > INTERACT_RANGE_SQ;

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

function stopTrackingContainer(playerId: string): void {
  openContainers.delete(playerId);
}

// ── Finalize a tracked container and sort once after interaction
function finalizeContainer(playerId: string): void {
  const tracked = openContainers.get(playerId);
  if (!tracked) return;

  openContainers.delete(playerId);
  if (!tracked.pendingSort) return;

  const state = getTrackedContainerState(tracked);
  if (!state) return;

  sortContainerTargets(state.targets);
}

function queueInventorySort(player: Player): void {
  if (openContainers.has(player.id)) return;
  if (inventorySortInProgress.has(player.id)) return;

  const token = (inventorySortTokens.get(player.id) ?? 0) + 1;
  inventorySortTokens.set(player.id, token);

  system.runTimeout(() => {
    if (inventorySortTokens.get(player.id) !== token) return;
    if (openContainers.has(player.id)) return;

    try {
      inventorySortInProgress.add(player.id);
      sortContainer(player.getComponent("inventory")!.container!, HOTBAR_SIZE);
    } catch {
      // player may be invalid during respawn, dimension changes, or logout
    } finally {
      inventorySortInProgress.delete(player.id);
    }
  }, INVENTORY_SORT_DELAY_TICKS);
}

function isTrackingBlockInView(player: Player, tracked: TrackedContainer): boolean {
  try {
    const hit = player.getBlockFromViewDirection({
      maxDistance: Math.sqrt(INTERACT_RANGE_SQ),
      includeLiquidBlocks: false,
      includePassableBlocks: true,
    });

    const block = hit?.block;
    return !!block && block.dimension.id === tracked.dimensionId && hasTrackedBlock(tracked.blocks, block.location);
  } catch {
    return false;
  }
}

// ── Sort helpers ───────────────────────────────────────────────
function getBlockContainer(block: Block): Container | undefined {
  const inv = block.getComponent("inventory");
  return inv?.container;
}

function getBlockContainerState(block: Block): ResolvedContainerGroup | undefined {
  const targets = resolveContainerTargets(block);
  if (!targets) return undefined;

  return {
    targets,
    blocks: targets.map(({ block: targetBlock }) => toTrackedBlock(targetBlock.location)),
    groupKey: getContainerGroupKey(targets),
    ...getContainerStateFromTargets(targets),
  };
}

function getTrackedContainerState(tracked: TrackedContainer): ResolvedContainerGroup | undefined {
  try {
    const dim = world.getDimension(tracked.dimensionId);
    const block = dim.getBlock(tracked.blocks[0]);
    if (!block) return undefined;
    return getBlockContainerState(block);
  } catch {
    return undefined;
  }
}

function resolveContainerTargets(block: Block): ContainerTarget[] | undefined {
  const primary = getBlockContainer(block);
  if (!primary) return undefined;

  const pair = getPairedChestBlock(block);
  if (!pair) {
    return [{ block, container: primary }];
  }

  const secondary = getBlockContainer(pair);
  if (!secondary) {
    return [{ block, container: primary }];
  }

  return [
    { block, container: primary },
    { block: pair, container: secondary },
  ].sort(compareContainerTargets);
}

function getPairedChestBlock(block: Block): Block | undefined {
  if (!isPairableChestBlock(block.typeId)) return undefined;

  const facing = block.permutation.getState("minecraft:cardinal_direction");
  for (const adjacent of getHorizontalNeighbors(block)) {
    if (!adjacent) continue;
    if (adjacent.typeId !== block.typeId) continue;
    if (adjacent.permutation.getState("minecraft:cardinal_direction") !== facing) continue;
    if (!getBlockContainer(adjacent)) continue;
    return adjacent;
  }

  return undefined;
}

function isPairableChestBlock(typeId: string): boolean {
  return typeId === "minecraft:chest" || typeId === "minecraft:trapped_chest";
}

function getHorizontalNeighbors(block: Block): Array<Block | undefined> {
  return [block.north(), block.south(), block.east(), block.west()];
}

function compareContainerTargets(left: ContainerTarget, right: ContainerTarget): number {
  return compareTrackedBlocks(left.block.location, right.block.location);
}

function compareTrackedBlocks(left: TrackedBlock, right: TrackedBlock): number {
  return left.x - right.x || left.y - right.y || left.z - right.z;
}

function toTrackedBlock(location: { x: number; y: number; z: number }): TrackedBlock {
  return {
    x: location.x,
    y: location.y,
    z: location.z,
  };
}

function getContainerGroupKey(targets: ContainerTarget[]): string {
  return targets
    .map(({ block }) => `${block.location.x},${block.location.y},${block.location.z}`)
    .join("|");
}

function getContainerStateFromTargets(targets: ContainerTarget[]): { itemTotal: number; snapshot: string } {
  let itemTotal = 0;
  const snapshot: string[] = [];

  for (const { container } of targets) {
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (!item) {
        snapshot.push("_");
        continue;
      }

      itemTotal += item.amount;
      snapshot.push(`${item.typeId}:${item.amount}:${item.nameTag ?? ""}`);
    }
  }

  return {
    itemTotal,
    snapshot: snapshot.join("|"),
  };
}

function sortContainerTargets(targets: ContainerTarget[]): void {
  const items: ItemStack[] = [];

  for (const { container } of targets) {
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (item) items.push(item.clone());
    }
  }

  if (items.length === 0) return;

  const merged = mergeStacks(items);
  merged.sort((a, b) => a.typeId.localeCompare(b.typeId) || b.amount - a.amount);

  let mergedIndex = 0;
  for (const { container } of targets) {
    for (let i = 0; i < container.size; i++) {
      container.setItem(i, merged[mergedIndex] ?? undefined);
      mergedIndex += 1;
    }
  }
}

function hasTrackedBlock(blocks: TrackedBlock[], location: { x: number; y: number; z: number }): boolean {
  return blocks.some((block) => block.x === location.x && block.y === location.y && block.z === location.z);
}

function distanceSqToTrackedBlocks(location: { x: number; y: number; z: number }, blocks: TrackedBlock[]): number {
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const block of blocks) {
    bestDistance = Math.min(bestDistance, distanceSq(location, block));
  }

  return bestDistance;
}

function sortContainer(container: Container, startSlot: number): void {
  const size = container.size;

  const items: ItemStack[] = [];
  for (let i = startSlot; i < size; i++) {
    const item = container.getItem(i);
    if (item) items.push(item.clone());
  }
  if (items.length === 0) return;

  const merged = mergeStacks(items);
  merged.sort((a, b) => a.typeId.localeCompare(b.typeId) || b.amount - a.amount);

  for (let i = startSlot; i < size; i++) {
    container.setItem(i, merged[i - startSlot] ?? undefined);
  }
}

function mergeStacks(items: ItemStack[]): ItemStack[] {
  const result: ItemStack[] = [];
  for (const item of items) {
    let remaining = item.amount;
    for (const stack of result) {
      if (remaining <= 0) break;
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

function distanceSq(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}
