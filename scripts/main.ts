import { world, system, Player, Block, Container, ItemStack } from "@minecraft/server";

// ── Constants ──────────────────────────────────────────────────
const HOTBAR_SIZE = 9;
const SORT_INTERVAL = 40; // ticks (~2 seconds)
const INTERACT_RANGE_SQ = 49; // 7 blocks squared

// ── Track open containers per player ───────────────────────────
interface TrackedContainer {
  x: number;
  y: number;
  z: number;
  dimensionId: string;
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

  const prev = openContainers.get(player.id);

  // Same container reopened — skip sort, just keep tracking
  const sameBlock =
    prev &&
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
        sortContainer(player.getComponent("inventory")!.container!, HOTBAR_SIZE);
      } catch {
        // player in invalid state (loading, dead, etc.)
      }
      continue;
    }

    // Detect container close: player walked away

    const far =
      player.dimension.id !== tracked.dimensionId ||
      distanceSq(player.location, tracked) > INTERACT_RANGE_SQ;

    if (far) finalizeContainer(player.id);
  }
}, SORT_INTERVAL);

// ── Cleanup on leave ───────────────────────────────────────────
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  finalizeContainer(playerId);
});

// ── Finalize (sort on close) a tracked container ───────────────
function finalizeContainer(playerId: string): void {
  const tracked = openContainers.get(playerId);
  if (!tracked) return;
  openContainers.delete(playerId);

  try {
    const dim = world.getDimension(tracked.dimensionId);
    const block = dim.getBlock(tracked);
    if (block) sortBlockContainer(block);
  } catch {
    // chunk unloaded or block gone
  }
}

// ── Sort helpers ───────────────────────────────────────────────
function sortBlockContainer(block: Block): void {
  const inv = block.getComponent("inventory");
  if (inv?.container) sortContainer(inv.container, 0);
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
