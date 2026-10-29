import { memoryConfigurationLayer } from "@usine/config/memory";
import { ConfigParser } from "@usine/config/parser";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Layer } from "effect";

export const configurationLayer = memoryConfigurationLayer.pipe(
  Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
);
