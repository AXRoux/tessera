/**
 * Where each supplier on file is headquartered, for the case map. Each pin sits on its own true point; suppliers in one
 * metro fan out around it, each with a leader line back to where it really is.
 *
 * Street addresses are the companies' own published ones, geocoded with OpenStreetMap (Nominatim), checked 2026-11-19.
 * Where a company publishes its headquarters city but no office address, the pin is the city itself (San Francisco City
 * Hall), and says so: a guessed street would be less accurate, not more.
 */
export interface Place {
  /** As the map writes it: the street address when published, else the city. */
  address: string;
  city: string;
  /** Suppliers in one metro fan out around it together. */
  metro: string;
  lat: number;
  lon: number;
  /** Whether the point is the office itself or only the headquarters city. */
  precision: "address" | "city";
  /** Where the location comes from. */
  source: string;
}

const SAN_FRANCISCO = { city: "San Francisco", metro: "bay-area", lat: 37.7793, lon: -122.4193 } as const;

export const SUPPLIER_PLACES: Record<string, Place> = {
  modal: {
    address: "233 Spring St, New York", city: "New York", metro: "new-york", lat: 40.7257, lon: -74.0048, precision: "address",
    source: "modal.com, Visit us: New York City (headquarters), with offices in San Francisco and Stockholm",
  },
  replicate: {
    address: "101 Townsend St, San Francisco", city: "San Francisco", metro: "bay-area", lat: 37.7803, lon: -122.3906, precision: "address",
    source: "replicate.com terms and privacy policy",
  },
  fal: {
    ...SAN_FRANCISCO, address: "San Francisco", precision: "city",
    source: "fal.ai: headquartered in San Francisco (its published street address is a mail drop, so it is not used)",
  },
  langchain: {
    ...SAN_FRANCISCO, address: "San Francisco", precision: "city",
    source: "langchain.com: headquartered in San Francisco, with offices in New York, Boston and Amsterdam",
  },
  primeintellect: {
    ...SAN_FRANCISCO, address: "San Francisco", precision: "city",
    source: "Wikidata Q137409007 (company in San Francisco); primeintellect.ai terms set venue in San Francisco",
  },
  framer: {
    address: "Rozengracht 207B, Amsterdam", city: "Amsterdam", metro: "amsterdam", lat: 52.3724, lon: 4.8775, precision: "address",
    source: "framer.com privacy statement: Framer B.V., Rozengracht 207B, 1016 LZ Amsterdam",
  },
};

/** Where the globe faces at rest: North America, where most suppliers are, with Amsterdam in view on the rim. */
export const GLOBE_REST = { lat: 36, lon: -98 };
