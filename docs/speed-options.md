# Session speed selection

The `fast-mode` session config option selects a service tier. Its ID and existing
`off`/`on` values remain compatible with older clients:

| Display name | Select value | Turn service tier |
| --- | --- | --- |
| Standard | `off` | `null` |
| Fast | `on` | `fast` |
| Ultrafast | `ultrafast` | `ultrafast` |

Ultrafast is offered only when the selected model advertises it through
`serviceTiers` or the older `additionalSpeedTiers` field. Model names are not
hardcoded. Availability and usage remain subject to Codex account eligibility.

For models with Ultrafast, the option is a select even if the client supports
boolean options. For other Fast-capable models, boolean-capable clients retain
the existing Fast mode toggle; clients without boolean support see Standard/Fast.
Models supporting neither accelerated tier do not advertise the option.

Use `session/set_config_option` with `configId: "fast-mode"` and the advertised
value. ACP v2 clients use `type: "id"` for the select, or `type: "boolean"` for
the toggle. Successful changes return updated config options and subsequent
prompts use the selected tier. Invalid or unsupported Ultrafast choices are
rejected. Older boolean and `on`/`off` requests retain their meaning in ACP v1.

New and restored sessions recognize Ultrafast returned by Codex. When switching
to a model without Ultrafast, an Ultrafast selection becomes Fast if supported,
otherwise Standard; updated options report this fallback.

This adds no model, reasoning-effort, or speed default. Other externally selected
tiers, such as Flex, are outside this control's scope; preserving them is tracked
separately in #673.
