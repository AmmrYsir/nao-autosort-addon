import { world, system, Player, Block, Container, ItemStack } from "@minecraft/server";

// -- Constants --------------------------------------------------
const HOTBAR_SIZE = 9;
const INVENTORY_SORT_DELAY_TICKS = 2;

// -- State ------------------------------------------------------
const recentContainerInteract = new Set<string>();
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

// -- Sort container on open -------------------------------------
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block, isFirstEvent }) => {
  if (!isFirstEvent) return;
  if (!isContainerBlock(block.typeId)) return;

  sortBlockContainer(block, 0);

  // Briefly suppress inventory sort so picking items from a
  // freshly-sorted container doesn't immediately re-sort inventory
  recentContainerInteract.add(player.id);
  system.runTimeout(() => {
    recentContainerInteract.delete(player.id);
  }, 10);
});

function sortBlockContainer(block: Block, attempt: number): void {
  const container = block.getComponent("inventory")?.container;
  if (!container) {
    if (attempt < 3) {
      const x = block.location.x;
      const y = block.location.y;
      const z = block.location.z;
      const dimId = block.dimension.id;
      system.runTimeout(() => {
        try {
          const b = world.getDimension(dimId).getBlock({ x, y, z });
          if (b && isContainerBlock(b.typeId)) sortBlockContainer(b, attempt + 1);
        } catch { /* block may be invalid */ }
      }, 5);
    }
    return;
  }

  sortContainer(container, 0);
}

// -- Live-sort player inventory on change -----------------------
world.afterEvents.playerInventoryItemChange.subscribe(({ player }) => {
  queueInventorySort(player);
});

function queueInventorySort(player: Player): void {
  if (recentContainerInteract.has(player.id)) return;
  if (inventorySortInProgress.has(player.id)) return;

  const token = (inventorySortTokens.get(player.id) ?? 0) + 1;
  inventorySortTokens.set(player.id, token);

  system.runTimeout(() => {
    if (inventorySortTokens.get(player.id) !== token) return;
    if (recentContainerInteract.has(player.id)) return;

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

// -- Cleanup on leave -------------------------------------------
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  recentContainerInteract.delete(playerId);
  inventorySortTokens.delete(playerId);
  inventorySortInProgress.delete(playerId);
});

// -- Sort helpers -----------------------------------------------
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
