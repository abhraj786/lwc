const memoized = Symbol();
export default function ($api, $cmp, $slotset) {
    const _expr = $cmp.bar || undefined;

    const m = $cmp[memoized] || ($cmp[memoized] = {});
    return [$api.h(
        "section",
        {},
        [$api.h(
            "p",
            {},
            ["1"]
        ), _expr && $api.h(
            "p",
            {},
            ["2"]
        ), $api.h(
            "p",
            {},
            ["3"]
        )]
    )];
}
export const templateUsedIds = ["bar"];
