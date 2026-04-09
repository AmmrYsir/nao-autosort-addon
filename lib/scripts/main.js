import { world, system } from "@minecraft/server";
// -- Constants --------------------------------------------------
const HOTBAR_SIZE = 9;
const INVENTORY_SORT_DELAY_TICKS = 2;
// -- State ------------------------------------------------------
const recentContainerInteract = new Set();
const inventorySortTokens = new Map();
const inventorySortInProgress = new Set();
function isContainerBlock(typeId) {
    return (typeId === "minecraft:chest" ||
        typeId === "minecraft:trapped_chest" ||
        typeId === "minecraft:barrel" ||
        typeId.endsWith("shulker_box"));
}
// -- Sort container on open -------------------------------------
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block, isFirstEvent }) => {
    if (!isFirstEvent)
        return;
    if (!isContainerBlock(block.typeId))
        return;
    sortBlockContainer(block, 0);
    // Briefly suppress inventory sort so picking items from a
    // freshly-sorted container doesn't immediately re-sort inventory
    recentContainerInteract.add(player.id);
    system.runTimeout(() => {
        recentContainerInteract.delete(player.id);
    }, 10);
});
function sortBlockContainer(block, attempt) {
    var _a;
    const container = (_a = block.getComponent("inventory")) === null || _a === void 0 ? void 0 : _a.container;
    if (!container) {
        if (attempt < 3) {
            const x = block.location.x;
            const y = block.location.y;
            const z = block.location.z;
            const dimId = block.dimension.id;
            system.runTimeout(() => {
                try {
                    const b = world.getDimension(dimId).getBlock({ x, y, z });
                    if (b && isContainerBlock(b.typeId))
                        sortBlockContainer(b, attempt + 1);
                }
                catch ( /* block may be invalid */_a) { /* block may be invalid */ }
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
function queueInventorySort(player) {
    var _a;
    if (recentContainerInteract.has(player.id))
        return;
    if (inventorySortInProgress.has(player.id))
        return;
    const token = ((_a = inventorySortTokens.get(player.id)) !== null && _a !== void 0 ? _a : 0) + 1;
    inventorySortTokens.set(player.id, token);
    system.runTimeout(() => {
        if (inventorySortTokens.get(player.id) !== token)
            return;
        if (recentContainerInteract.has(player.id))
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
// -- Cleanup on leave -------------------------------------------
world.afterEvents.playerLeave.subscribe(({ playerId }) => {
    recentContainerInteract.delete(playerId);
    inventorySortTokens.delete(playerId);
    inventorySortInProgress.delete(playerId);
});
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
function getCategory(typeId) {
    const name = typeId.startsWith("minecraft:") ? typeId.substring(10) : typeId;
    if (WEAPON_EXACT.has(typeId))
        return 0 /* Category.Weapon */;
    for (const s of WEAPON_SUFFIXES)
        if (name.endsWith(s))
            return 0 /* Category.Weapon */;
    if (TOOL_EXACT.has(typeId))
        return 1 /* Category.Tool */;
    for (const s of TOOL_SUFFIXES)
        if (name.endsWith(s))
            return 1 /* Category.Tool */;
    if (ARMOR_EXACT.has(typeId))
        return 2 /* Category.Armor */;
    for (const s of ARMOR_SUFFIXES)
        if (name.endsWith(s))
            return 2 /* Category.Armor */;
    if (FOOD_EXACT.has(typeId))
        return 3 /* Category.Food */;
    for (const p of FOOD_PREFIXES)
        if (name.startsWith(p))
            return 3 /* Category.Food */;
    if (BLOCK_EXACT.has(typeId))
        return 4 /* Category.Block */;
    for (const s of BLOCK_SUFFIXES)
        if (name.endsWith(s))
            return 4 /* Category.Block */;
    return 5 /* Category.Misc */;
}
function compareItems(a, b) {
    const catDiff = getCategory(a.typeId) - getCategory(b.typeId);
    if (catDiff !== 0)
        return catDiff;
    return a.typeId.localeCompare(b.typeId) || b.amount - a.amount;
}
function sortContainer(container, startSlot) {
    var _a;
    const size = container.size;
    // Read all slots — no cloning yet
    const slots = [];
    for (let i = startSlot; i < size; i++) {
        slots.push({ index: i, item: container.getItem(i) });
    }
    // Merge stacks (clones only during merge)
    const items = slots.filter((s) => s.item != null).map((s) => s.item);
    if (items.length === 0)
        return;
    const merged = mergeStacks(items);
    merged.sort(compareItems);
    // Only clone and write slots that actually changed
    for (let i = startSlot; i < size; i++) {
        const sortedItem = merged[i - startSlot];
        const currentItem = slots[i - startSlot].item;
        const sortedKey = sortedItem ? `${sortedItem.typeId}:${sortedItem.amount}` : "";
        const currentKey = currentItem ? `${currentItem.typeId}:${currentItem.amount}` : "";
        if (sortedKey !== currentKey) {
            container.setItem(i, (_a = sortedItem === null || sortedItem === void 0 ? void 0 : sortedItem.clone()) !== null && _a !== void 0 ? _a : undefined);
        }
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
//# sourceMappingURL=main.js.map