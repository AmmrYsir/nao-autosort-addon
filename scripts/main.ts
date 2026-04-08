import { world, system, Player, Block, Container, ItemStack } from "@minecraft/server";

// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const PLAYER_SORT_INTERVAL = 40; // ticks (~2 seconds)
const CONTAINER_CHECK_INTERVAL = 4; // ticks (~0.2 seconds)
const INTERACT_RANGE_SQ = 49; // 7 blocks squared

// ── Track open containers per player ───────────────────────────
interface TrackedContainer {
  x: number;
  y: number;
  z: number;
  dimensionId: string;
  itemTotal: number;
  snapshot: string;
  pendingSort: boolean;
}
const openContainers = new Map<string, TrackedContainer>();

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
  });
});

// ── Periodic: auto-sort player inventory ───────────────────────
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (openContainers.has(player.id)) continue;

    try {
      sortContainer(player.getComponent("inventory")!.container!, HOTBAR_SIZE);
    } catch {
      // player in invalid state (loading, dead, etc.)
    }
  }
}, PLAYER_SORT_INTERVAL);

// ── Periodic: monitor open containers for changes and close detection
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const tracked = openContainers.get(player.id);
    if (!tracked) continue;

    const far =
      player.dimension.id !== tracked.dimensionId ||
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
      tracked.itemTotal = state.itemTotal;
      tracked.snapshot = state.snapshot;
      tracked.pendingSort = true;
    }
  }
}, CONTAINER_CHECK_INTERVAL);

// ── Cleanup on leave ───────────────────────────────────────────
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  finalizeContainer(playerId);
});

// ── Finalize a tracked container and sort once after interaction
function finalizeContainer(playerId: string): void {
  const tracked = openContainers.get(playerId);
  if (!tracked) return;

  openContainers.delete(playerId);
  if (!tracked.pendingSort) return;

  const state = getTrackedContainerState(tracked);
  if (!state) return;

  sortContainer(state.container, 0);
}

// ── Sort helpers ───────────────────────────────────────────────
function getBlockContainer(block: Block): Container | undefined {
  const inv = block.getComponent("inventory");
  return inv?.container;
}

function getBlockContainerState(block: Block): { container: Container; itemTotal: number; snapshot: string } | undefined {
  const container = getBlockContainer(block);
  if (!container) return undefined;
  return { container, ...getContainerState(container) };
}

function getTrackedContainerState(tracked: TrackedContainer): { container: Container; itemTotal: number; snapshot: string } | undefined {
  try {
    const dim = world.getDimension(tracked.dimensionId);
    const block = dim.getBlock(tracked);
    if (!block) return undefined;
    return getBlockContainerState(block);
  } catch {
    return undefined;
  }
}

function getContainerState(container: Container): { itemTotal: number; snapshot: string } {
  let itemTotal = 0;
  const snapshot: string[] = [];

  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (!item) {
      snapshot.push("_");
      continue;
    }

    itemTotal += item.amount;
    snapshot.push(`${item.typeId}:${item.amount}:${item.nameTag ?? ""}`);
  }

  return {
    itemTotal,
    snapshot: snapshot.join("|"),
  };
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
