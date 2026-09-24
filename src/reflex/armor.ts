/** True for wearable armor items (helmets, chestplates, leggings and boots, including turtle shells). */
export function isArmorName(name: string): boolean {
  return /_(helmet|chestplate|leggings|boots)$/.test(name) || name === 'turtle_helmet';
}
