#!/usr/bin/env bash
# Prints a Claude-style conversation for the VHS demo (docs/demos/claude.tape).
# 24-bit ANSI; body text inherits the terminal's ink foreground.

coral=$'\033[38;2;217;119;87m'   # Claude clay/coral accent
muted=$'\033[38;2;138;127;112m'  # warm grey
bold=$'\033[1m'
ul=$'\033[4m'
r=$'\033[0m'

say()   { printf '%s\n' "$1"; }
think() { printf '%s\n\n' "${muted}  ✦ $1${r}"; }
who()   { printf '%s\n' "$1"; }

who "${muted}${bold}You${r}"
say "plan a trip to Ravenna through the Brenner Pass, leaving Roskilde 22 July."
say "max 10 hours driving a day. i'm bringing kids so charging near playgrounds"
printf '%s\n\n' "is a must — and suggest hotel stops."

who "${coral}${bold}Claude${r}"
think "Architected a multi-day family road trip with playground charge stops"
say "~1,693 km, ~16 h driving (ABRP even routes the Rødby–Puttgarden ferry)."
say "Under a 10 h/day cap that's 2 days minimum — but with kids I'd do 3 relaxed"
printf '%s\n\n' "days, each 5–7 h, with room to let them run:"
printf '%s\n' "  ${bold}Day 1 · 22 Jul${r}   Roskilde → Göttingen     ~560 km · ~6 h"
say "${muted}       ferry + A7 · break: Serengeti-Park safari · stay: Hotel FREIgeist${r}"
printf '%s\n' "  ${bold}Day 2 · 23 Jul${r}   Göttingen → Innsbruck    ~650 km · ~6.5 h"
say "${muted}       via Würzburg · break: PLAYMOBIL FunPark · stay: Hotel Das Innsbruck${r}"
printf '%s\n' "  ${bold}Day 3 · 24 Jul${r}   Innsbruck → Ravenna      ~480 km · ~4.5 h"
printf '%s\n\n' "${muted}       over the Brenner to Lake Garda · charge at Affi, Gardaland right there${r}"
say "Charging lines up with every kid break (~2 stops/day, 20–35 min). Book the"
printf '%s\n\n' "ferry ahead; Austria needs a vignette + the Brenner toll."

who "${muted}${bold}You${r}"
printf '%s\n\n' "link me the abrp link"

who "${coral}${bold}Claude${r}"
think "Retrieved a shareable routing link"
printf '%s\n\n' "  ${coral}${ul}https://abetterrouteplanner.com/?plan_uuid=2-6a2852a7-d113c13d239740960b590ec7${r}"
say "Built on the Model Y Long Range profile, and the Göttingen / Innsbruck"
say "overnights are mine — ABRP plans one continuous drive. Log in to ABRP to"
say "save and edit it."
