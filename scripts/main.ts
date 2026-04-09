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

// Category order: lower number = higher priority (sorted first)
const enum Category {
  Weapon = 0,
  Tool = 1,
  Armor = 2,
  Food = 3,
  Block = 4,
  Misc = 5,
}

const WEAPON_SUFFIXES = ["_sword", "_spear"];
const WEAPON_EXACT = new Set(["minecraft:bow", "minecraft:crossbow", "minecraft:trident", "minecraft:mace"]);
const TOOL_SUFFIXES = ["_pickaxe", "_axe", "_shovel", "_hoe"];
const TOOL_EXACT = new Set([
  "minecraft:fishing_rod", "minecraft:flint_and_steel", "minecraft:shears",
  "minecraft:shield", "minecraft:spyglass", "minecraft:compass", "minecraft:clock",
  "minecraft:lead", "minecraft:name_tag", "minecraft:brush",
]);
const ARMOR_SUFFIXES = ["_helmet", "_chestplate", "_leggings", "_boots", "_nautilus_armor"];
const ARMOR_EXACT = new Set(["minecraft:turtle_helmet", "minecraft:elytra"]);
const FOOD_EXACT = new Set([
  "minecraft:apple", "minecraft:golden_apple", "minecraft:enchanted_golden_apple",
  "minecraft:bread", "minecraft:cookie", "minecraft:cake", "minecraft:pumpkin_pie",
  "minecraft:melon_slice", "minecraft:sweet_berries", "minecraft:glow_berries",
  "minecraft:beef", "minecraft:porkchop", "minecraft:chicken", "minecraft:mutton",
  "minecraft:rabbit", "minecraft:cod", "minecraft:salmon", "minecraft:tropical_fish",
  "minecraft:rabbit_stew", "minecraft:mushroom_stew", "minecraft:beetroot_soup",
  "minecraft:suspicious_stew", "minecraft:baked_potato", "minecraft:poisonous_potato",
  "minecraft:dried_kelp", "minecraft:beetroot", "minecraft:carrot", "minecraft:potato",
  "minecraft:golden_carrot", "minecraft:rotten_flesh", "minecraft:spider_eye",
  "minecraft:chorus_fruit",
]);
const FOOD_PREFIXES = ["cooked_"];
const BLOCK_SUFFIXES = [
  "_log", "_wood", "_planks", "_slab", "_stairs", "_wall", "_fence", "_door",
  "_trapdoor", "_bricks", "_ore", "_block", "_carpet", "_wool", "_terracotta",
  "_concrete", "_glass", "_pane",
];
const BLOCK_EXACT = new Set([
  "minecraft:cobblestone", "minecraft:stone", "minecraft:deepslate",
  "minecraft:dirt", "minecraft:grass_block", "minecraft:sand", "minecraft:red_sand",
  "minecraft:gravel", "minecraft:clay", "minecraft:mud", "minecraft:netherrack",
  "minecraft:end_stone", "minecraft:obsidian", "minecraft:sandstone",
  "minecraft:red_sandstone", "minecraft:basalt", "minecraft:blackstone",
  "minecraft:tuff", "minecraft:calcite", "minecraft:dripstone_block",
  "minecraft:torch", "minecraft:crafting_table", "minecraft:furnace",
  "minecraft:chest", "minecraft:barrel",
]);

function getCategory(typeId: string): Category {
  const name = typeId.startsWith("minecraft:") ? typeId.substring(10) : typeId;

  if (WEAPON_EXACT.has(typeId)) return Category.Weapon;
  for (const s of WEAPON_SUFFIXES) if (name.endsWith(s)) return Category.Weapon;

  if (TOOL_EXACT.has(typeId)) return Category.Tool;
  for (const s of TOOL_SUFFIXES) if (name.endsWith(s)) return Category.Tool;

  if (ARMOR_EXACT.has(typeId)) return Category.Armor;
  for (const s of ARMOR_SUFFIXES) if (name.endsWith(s)) return Category.Armor;

  if (FOOD_EXACT.has(typeId)) return Category.Food;
  for (const p of FOOD_PREFIXES) if (name.startsWith(p)) return Category.Food;

  if (BLOCK_EXACT.has(typeId)) return Category.Block;
  for (const s of BLOCK_SUFFIXES) if (name.endsWith(s)) return Category.Block;

  return Category.Misc;
}

function compareItems(a: ItemStack, b: ItemStack): number {
  const catDiff = getCategory(a.typeId) - getCategory(b.typeId);
  if (catDiff !== 0) return catDiff;
  return a.typeId.localeCompare(b.typeId) || b.amount - a.amount;
}

interface SlotEntry {
  index: number;
  item: ItemStack | undefined;
}

function sortContainer(container: Container, startSlot: number): void {
  const size = container.size;

  // Read all slots — no cloning yet
  const slots: SlotEntry[] = [];
  for (let i = startSlot; i < size; i++) {
    slots.push({ index: i, item: container.getItem(i) });
  }

  // Merge stacks (clones only during merge)
  const items = slots.filter((s) => s.item != null).map((s) => s.item!);
  if (items.length === 0) return;

  const merged = mergeStacks(items);
  merged.sort(compareItems);

  // Only clone and write slots that actually changed
  for (let i = startSlot; i < size; i++) {
    const sortedItem = merged[i - startSlot];
    const currentItem = slots[i - startSlot].item;

    const sortedKey = sortedItem ? `${sortedItem.typeId}:${sortedItem.amount}` : "";
    const currentKey = currentItem ? `${currentItem.typeId}:${currentItem.amount}` : "";

    if (sortedKey !== currentKey) {
      container.setItem(i, sortedItem?.clone() ?? undefined);
    }
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
