# Inside a decision

Silent, standalone OpenNeko prototype. All records and projections are invented. No connected AI, database, audio, messaging, or external business actions. Fonts use Google Fonts with system fallbacks.

Run from the repository root:

```sh
python3 -m http.server 4317 --bind 127.0.0.1 --directory prototypes/immersive
```

Open http://127.0.0.1:4317. Step inside the order, select dependency labels for evidence, scrub September 6–14, rehearse a split shipment, toggle reservation protection, hold to compare the original plan, and review a mock approval. Typed intents are scripted.

Scenario: Alpine orders 120 bikes at $900 each ($108,000), promised September 10. Of 104 on hand, 24 are reserved for Summit (promised September 9), leaving 80 available. Another 40 arrive September 12. Outbound transit is two days. Original plan delivers all 120 September 14. Protected split delivers 80 September 8 and 40 September 14, for $480 extra freight. Diverting Summit's reservation gives Alpine 104 early and 16 later but puts Summit at risk. The prototype does not model Summit's recovery. These are scenario assumptions, not an actual forecast.

Art direction: quiet dimensional workspace. Each block is one bike. Continuous object transformations show stock availability, dependency separation, and shipment splitting. Product Archivo/Manrope typography retained in an experimental standalone theme. All sound removed.
