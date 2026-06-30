import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const source = JSON.parse(readFileSync(new URL('../combat参考/combat_data.json', import.meta.url), 'utf8'));
source.meta = {
  schema_version: '1.0.0',
  source: 'combat参考/combat_data.json',
  locale: 'zh-CN',
  purpose: '单场战斗的规则运行数据'
};
source.global.armor = {
  absorb_from_rank: 'light',
  points_per_hit: 1,
  reduce_rank_steps: 1,
  broken_at: 0,
  broken_defense_modifier: -3,
  recover_at: 1
};
source.global.dice.environment_advantage = '1d6';
source.global.dice.environment_disadvantage = '-1d6';
source.global.environment_modifier_scope = 'attack_hit_check_only';
delete source.actors.water_hag.traits.wetland_hunter;
source.actors.manticore_test.id = 'manticore_test';
delete source.actors.manticore_test.actions.flying_escape.uses_exact_flight_distance;
source.actors.rotfiend.traits.corpse_explosion.effects[0].effect.target_scope = 'all_other_actors';
source.actors.manticore_test.attacks.diving_assault.on_miss[0].target = 'self';
source.actors.foglet.attacks.false_double.on_miss[0].target = 'player';
source.actors.venomous_arachas.parts.carapace = source.actors.venomous_arachas.parts.front_carapace;
source.actors.venomous_arachas.parts.carapace.name_zh = '甲壳';
delete source.actors.venomous_arachas.parts.front_carapace;
delete source.actors.venomous_arachas.traits.armored_front;
source.global.monster_difficulty_scale.description_zh = '衡量一只怪物对当前杰洛特模板的综合威胁。';
const rewrites: Record<string, string> = {
  another_allied_pack_hunter_is_engaging_same_target: 'another_allied_pack_hunter_present',
  at_least_one_other_allied_pack_hunter_is_engaging_same_target: 'another_allied_pack_hunter_present',
  two_or_more_allied_nekkers_are_engaging_same_target: 'two_or_more_allied_nekkers_present',
  another_allied_insectoid_is_engaging_same_target: 'another_allied_insectoid_present'
};
function walk(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(walk);
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'condition' && typeof entry === 'string' && rewrites[entry]) (value as Record<string, unknown>)[key] = rewrites[entry];
    else walk(entry);
  }
}
walk(source);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/combat.json', import.meta.url), JSON.stringify(source, null, 2) + '\n');
