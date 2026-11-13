/** What each merchant category code Tessera's cards use means, in Visa's words, shortened. */
const MCC_NAMES: Readonly<Record<string, string>> = {
  "5734": "Computer software stores",
  "5817": "Digital goods: apps",
  "5818": "Digital goods: large merchants",
  "7372": "Programming and data processing",
  "4816": "Network and information services",
  "7379": "Computer services",
  "7399": "Business services",
  "7311": "Advertising services",
  "4511": "Airlines",
  "7011": "Hotels and resorts",
  "4722": "Travel agencies",
  "5111": "Office and stationery supplies",
  "5943": "Office and school supply stores",
  "5044": "Office equipment",
  "7995": "Betting and gambling",
};

export const mccName = (code: string): string => MCC_NAMES[code] ?? `Merchant category ${code}`;
