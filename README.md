# NEBULA virtual worm

**Live page: https://davidenuzzi.github.io/nebula-worm/**

A *C. elegans* that moves in real time, driven by NEBULA, a generative model of whole-brain activity and behavior. In
the browser, the model draws one recording frame at a time. The decoded behavior drives a physical model of the
worm's body, and the page shows the decoded activity of 109 neurons, the behavior and the latent trajectory.

- **Generative.** The model runs on its own transition.
- **Closed loop.** The decoded activity is encoded back before each step. Neurons or groups of neurons can be
  silenced (held at their 1st-percentile activity).

Everything runs locally in the page: plain JavaScript, no build step, no server.

## Credits

- The model was trained on worm 1 of Kato et al., *Global brain dynamics embed the motor command sequence of
  Caenorhabditis elegans*, Cell 163, 656–669 (2015), https://doi.org/10.1016/j.cell.2015.09.034.
- The body is a JavaScript port of [ElegansBot](https://github.com/TaegonChung/ElegansBot) (MIT License,
  © 2023 Taegon Chung; the full notice is in `js/body.js`): Chung, Chang & Kim, *Development of equation of motion
  deciphering locomotion including omega turns of Caenorhabditis elegans*, eLife (2024),
  https://doi.org/10.7554/eLife.92562.
