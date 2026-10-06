import type { FinancialsDoc } from "./financials.ts";
import { periodHeader, periodPath, type Period } from "./periods.ts";

/**
 * Standard figures: the line items nearly every company reports, found under whatever
 * name this company's record gives them.
 *
 * Records are shaped to the business, so the same line item carries different field
 * names across companies: revenue is `revenue`, `total_revenues`, `net_sales`,
 * `total_net_revenue` or `total_sales_and_revenues`. Each standard figure lists the names
 * it answers to, in order of preference, and resolution is deterministic:
 *
 *   1. the field the company's own headline block uses for that figure, when it has one
 *      (that choice was made per company, with the filing in hand);
 *   2. the first listed name present in the period, in the listed blocks;
 *   3. a name pattern, but only when exactly one field in the block matches it.
 *
 * Nothing is ever estimated, derived or summed to fill a gap. The matched field is always
 * returned with the value, and every other field in the same block that looks like the
 * same thing is returned beside it as `related`, so a caller can see the alternatives
 * instead of trusting a silent pick.
 */

export type FigureKind = "money" | "per_share" | "shares" | "percent";

export interface FigureDef {
  id: string;
  label: string;
  kind: FigureKind;
  /** Period blocks searched, in order. "." means a scalar directly on the period. */
  blocks: string[];
  aliases: string[];
  /** Matched only when exactly one field in the block matches. */
  patterns?: RegExp[];
  /** Names tried only after the patterns: broader lines that stand in when nothing narrower exists. */
  lastResort?: string[];
  /** Headline metric labels that name this figure; their field is tried first. */
  headline?: RegExp;
  /** Other fields in the same blocks returned as `related`. */
  related?: RegExp;
  exclude?: RegExp;
  /** Words a caller might use for this figure. */
  synonyms: string[];
  definition: string;
  caveat?: string;
}

const IS = "income_statement";
const BS = "balance_sheet";
const CF = "cash_flow";

export const FIGURES: FigureDef[] = [
  // ---- Income statement ---------------------------------------------------
  {
    id: "revenue",
    label: "Revenue",
    kind: "money",
    blocks: [IS],
    aliases: [
      "revenue", "revenues", "total_revenues", "total_revenue", "net_sales", "total_net_sales",
      "net_revenue", "net_revenues", "total_net_revenue", "total_net_revenues",
      "total_operating_revenues", "operating_revenues", "total_sales_and_revenues",
      "sales_and_other_operating_revenues", "sales", "total_revenue_net_of_interest_expense",
      "total_revenues_net_of_interest_expense", "total_net_revenue_taxable_equivalent",
      "total_revenues_and_other_income", "revenue.total_revenues", "revenues.total_revenues",
      "revenue.total_revenue", "revenues.total_revenue",
    ],
    headline: /^(revenues?|net sales|net revenues?|total revenues?|total net revenues?|total revenues and other income|sales|total sales and revenues)$/i,
    related: /revenue|sales/,
    exclude: /cost|marketing|general|administrat|deferred|unearned|per_share|pct|percent|growth|days/,
    synonyms: ["revenue", "revenues", "sales", "net sales", "top line", "turnover", "total revenue", "net revenue"],
    definition:
      "The top line: total revenue, net sales or, for a bank, total net revenue (net of interest expense).",
  },
  {
    id: "cost_of_revenue",
    label: "Cost of revenue",
    kind: "money",
    blocks: [IS],
    aliases: [
      "cost_of_revenue", "cost_of_revenues", "total_cost_of_revenue", "total_cost_of_revenues",
      "cost_of_sales", "total_cost_of_sales", "cost_of_goods_sold", "cost_of_products_sold",
      "cost_of_goods_and_services_sold", "cost_of_sales_excluding_depreciation_and_amortization",
      "cost_of_products_sold_excluding_amortization", "cost_of_revenues.total_cost_of_revenues",
      "cost_of_revenue.total_cost_of_revenue", "cost_of_sales.total_cost_of_sales",
    ],
    related: /^cost_of|_cost_of_(sales|revenue)/,
    exclude: /restructuring/,
    synonyms: ["cost of revenue", "cost of sales", "cogs", "cost of goods sold"],
    definition: "Direct cost of the goods and services sold.",
  },
  {
    id: "gross_profit",
    label: "Gross profit",
    kind: "money",
    blocks: [IS],
    aliases: ["gross_profit", "gross_margin"],
    headline: /^gross profit$/i,
    related: /gross/,
    exclude: /pct|percent/,
    synonyms: ["gross profit", "gross income", "gross margin dollars"],
    definition: "Revenue less cost of revenue, as the company reports it.",
  },
  {
    id: "gross_margin_pct",
    label: "Gross margin (%)",
    kind: "percent",
    blocks: [IS, "derived", "key_metrics", "key_ratios"],
    aliases: ["gross_margin_pct", "gross_margin_percent", "gross_margin_percentage", "gross_margin_on_net_sales_pct"],
    synonyms: ["gross margin", "gross margin percent", "gross margin %"],
    definition: "Gross profit as a percentage of revenue, as stored in the record.",
  },
  {
    id: "research_and_development",
    label: "Research and development",
    kind: "money",
    blocks: [IS],
    aliases: [
      "research_and_development", "research_and_development_expenses", "research_and_development_expense",
      "research_development_and_engineering_expenses", "research_development_and_engineering",
      "product_development", "technology_and_infrastructure", "technology_and_development",
      "operating_expenses.research_and_development",
    ],
    related: /research|development|technology/,
    synonyms: ["r&d", "research and development", "research", "rd"],
    definition: "Research and development expense.",
  },
  {
    id: "sga",
    label: "Selling, general and administrative",
    kind: "money",
    blocks: [IS],
    aliases: [
      "selling_general_and_administrative", "selling_general_and_administrative_expenses",
      "selling_general_and_administrative_expense", "sales_general_and_administrative",
      "marketing_general_and_administrative", "selling_marketing_general_and_administrative",
      "selling_administrative_and_general_expenses", "selling_general_administrative_and_other",
      "operating_expenses.selling_general_and_administrative",
    ],
    related: /selling|general|administrat|marketing/,
    synonyms: ["sg&a", "sga", "selling general and administrative", "overhead"],
    definition:
      "Selling, general and administrative expense. Companies that report sales and marketing and general and administrative separately show both under related.",
  },
  {
    id: "operating_expenses",
    label: "Total operating expenses",
    kind: "money",
    blocks: [IS],
    aliases: [
      "total_operating_expenses", "operating_expenses", "total_costs_and_expenses",
      "total_operating_costs_and_expenses", "total_costs_and_operating_expenses",
      "total_operating_cost_and_expenses", "total_noninterest_expense", "total_non_interest_expense",
      "noninterest_expense", "total_expenses", "costs_and_expenses", "total_benefits_and_expenses",
      "operating_expenses.total_operating_expenses", "costs_and_expenses.total_costs_and_expenses",
    ],
    related: /expenses$|costs_and_expenses|noninterest_expense|non_interest_expense/,
    synonyms: ["operating expenses", "opex", "total expenses", "costs and expenses", "noninterest expense"],
    definition:
      "Total operating expenses, or total costs and expenses where the company presents one combined line; noninterest expense for a bank.",
  },
  {
    id: "operating_income",
    label: "Operating income",
    kind: "money",
    blocks: [IS],
    aliases: [
      "operating_income", "income_from_operations", "operating_profit", "operating_income_loss",
      "operating_earnings", "earnings_from_operations", "income_loss_from_operations",
    ],
    headline: /^(operating income|operating profit|operating earnings|income from operations)$/i,
    related: /operating_(income|profit|earnings)|from_operations/,
    exclude: /discontinued|continuing|other_operating|eps|per_share/,
    synonyms: ["operating income", "operating profit", "ebit", "income from operations"],
    definition: "Income from operations, before interest, other income and taxes.",
  },
  {
    id: "interest_expense",
    label: "Interest expense",
    kind: "money",
    blocks: [IS],
    aliases: ["interest_expense", "total_interest_expense", "interest_expense_net", "interest_and_debt_expense"],
    related: /interest_expense|interest_income/,
    exclude: /noninterest|non_interest|net_of_interest_expense/,
    synonyms: ["interest expense", "interest cost"],
    definition: "Interest expense. Sign follows the record (some files store expenses as negatives).",
    caveat: "Signs follow the company's record: an expense may be stored as a negative number.",
  },
  {
    id: "net_interest_income",
    label: "Net interest income",
    kind: "money",
    blocks: [IS, "bank_metrics", "key_metrics"],
    aliases: ["net_interest_income", "net_interest_income_fte"],
    headline: /^net interest income$/i,
    related: /interest_income|interest_expense/,
    exclude: /noninterest|non_interest/,
    synonyms: ["net interest income", "nii"],
    definition: "Interest income less interest expense. The core revenue line of a bank.",
  },
  {
    id: "noninterest_income",
    label: "Noninterest income",
    kind: "money",
    blocks: [IS],
    aliases: [
      "total_noninterest_income", "noninterest_income", "total_non_interest_revenue",
      "total_non_interest_revenues", "total_non_interest_income", "non_interest_income",
      "total_noninterest_revenue",
    ],
    related: /noninterest_income|non_interest_(income|revenue)/,
    synonyms: ["noninterest income", "non-interest income", "fee income", "non-interest revenue"],
    definition: "Fees, commissions, trading and other revenue a bank earns outside interest.",
  },
  {
    id: "provision_for_credit_losses",
    label: "Provision for credit losses",
    kind: "money",
    blocks: [IS],
    aliases: [
      "provision_for_credit_losses", "provision_for_loan_losses", "provision_for_credit_losses_and_benefits_and_claims",
      "total_provisions_for_credit_losses_and_benefits_and_claims", "credit_loss_provision", "provision_for_loan_and_lease_losses",
    ],
    related: /provision.*(credit|loan)|credit_loss/,
    synonyms: ["provision for credit losses", "loan loss provision", "credit provision", "provisions"],
    definition: "Expense set aside for expected loan and credit losses. Banks and lenders.",
  },
  {
    id: "pretax_income",
    label: "Income before income taxes",
    kind: "money",
    blocks: [IS],
    aliases: [
      "income_before_income_taxes", "income_before_income_tax", "earnings_before_income_taxes",
      "income_before_provision_for_income_taxes", "income_before_taxes", "income_before_income_tax_expense",
      "income_before_taxes_on_income", "pretax_income", "earnings_before_income_tax_expense",
      "earnings_before_taxes", "income_before_provision_for_taxes", "profit_before_taxes",
      "income_before_income_tax_provision", "pre_tax_earnings",
      "income_from_continuing_operations_before_income_taxes", "pretax_income_from_continuing_operations",
      "pretax_income_continuing_operations", "income_from_continuing_operations_before_taxes",
      "pretax_earnings_from_continuing_operations", "pretax_earnings",
      "income_before_income_taxes_and_equity_in_affiliated_companies_net_earnings",
      "income_before_income_taxes_and_equity_investments", "income_before_income_taxes_and_equity_method_investments",
      "earnings_before_income_taxes_and_equity_method_earnings",
      "income_loss_from_continuing_operations_before_income_taxes_and_other_items",
    ],
    related: /before_(income_)?tax|pretax|pre_tax/,
    synonyms: ["pretax income", "pre-tax income", "income before taxes", "ebt", "earnings before taxes"],
    definition: "Income before income taxes.",
  },
  {
    id: "income_tax",
    label: "Income tax expense",
    kind: "money",
    blocks: [IS],
    aliases: [
      "provision_for_income_taxes", "income_tax_expense", "income_tax_provision", "income_taxes",
      "income_tax_expense_benefit", "income_tax_provision_benefit", "provision_for_benefit_from_income_taxes",
      "provision_for_taxes", "provision_for_taxes_on_income", "taxes_on_earnings", "provision_benefit_for_income_taxes",
      "income_tax_expense_from_continuing_operations", "income_tax_benefit_provision", "provision_for_benefit_from_taxes",
      "provision_benefit_for_taxes_on_income", "taxes_on_income", "applicable_income_taxes",
    ],
    related: /tax/,
    exclude: /before|pretax|pre_tax|excise|net_of_tax|after_tax|other_than|property|rate|pct/,
    synonyms: ["income tax", "tax expense", "provision for income taxes", "taxes"],
    definition: "Provision for income taxes.",
  },
  {
    id: "effective_tax_rate",
    label: "Effective tax rate (%)",
    kind: "percent",
    blocks: [IS, "derived", "key_metrics", "key_ratios", "."],
    aliases: ["effective_tax_rate_pct", "effective_tax_rate", "effective_tax_rate_percent"],
    synonyms: ["effective tax rate", "tax rate", "etr"],
    definition: "Income tax expense as a percentage of pretax income, as stored in the record.",
  },
  {
    id: "net_income",
    label: "Net income",
    kind: "money",
    blocks: [IS],
    aliases: [
      "net_income", "net_earnings", "net_income_attributable_to_common_stockholders",
      "net_income_attributable_to_common_shareholders", "net_income_attributable_to_shareholders",
      "net_income_attributable_to_stockholders", "net_income_available_to_common_stockholders",
      "net_income_available_to_common_shareholders", "net_income_applicable_to_common_shareholders",
      "consolidated_net_income",
    ],
    patterns: [/^net_(income|earnings)_(attributable|available|applicable)_to_(?!noncontrolling|non_controlling|participating)/],
    headline: /^(net income|net earnings)( attributable.*)?$/i,
    related: /^net_(income|earnings)|net_income$|net_earnings$/,
    exclude: /per_share|margin|pct|eps/,
    synonyms: ["net income", "net earnings", "profit", "earnings", "bottom line", "net profit"],
    definition:
      "Net income. Where the record carries both consolidated net income and net income attributable to the company or its common shareholders, the one the company's own headline uses is primary and the other is shown under related.",
  },
  {
    id: "diluted_eps",
    label: "Diluted EPS",
    kind: "per_share",
    blocks: [IS, "per_share", "share_data"],
    aliases: [
      "diluted_eps", "eps_diluted", "earnings_per_share_diluted", "diluted_earnings_per_share",
      "diluted_net_income_per_share", "net_income_per_share_diluted", "diluted_eps_class_a",
    ],
    headline: /^diluted eps$/i,
    related: /eps|per_share/,
    exclude: /dividend|book_value|basic/,
    synonyms: ["diluted eps", "eps", "earnings per share", "diluted earnings per share"],
    definition: "Diluted earnings per share (per ADS for a foreign issuer with an ADR ratio).",
  },
  {
    id: "basic_eps",
    label: "Basic EPS",
    kind: "per_share",
    blocks: [IS, "per_share", "share_data"],
    aliases: [
      "basic_eps", "eps_basic", "earnings_per_share_basic", "basic_earnings_per_share",
      "basic_net_income_per_share", "net_income_per_share_basic", "basic_eps_class_a",
    ],
    related: /basic.*(eps|per_share)|(eps|per_share).*basic/,
    synonyms: ["basic eps", "basic earnings per share"],
    definition: "Basic earnings per share.",
  },
  {
    id: "diluted_shares",
    label: "Diluted weighted-average shares",
    kind: "shares",
    blocks: [IS, "per_share", "share_data"],
    aliases: [
      "diluted_shares", "weighted_average_shares_diluted", "weighted_average_diluted_shares",
      "diluted_weighted_average_shares", "diluted_weighted_average_shares_outstanding",
      "shares_diluted_weighted_average", "diluted_average_shares", "average_diluted_common_shares",
      "average_diluted_common_shares_issued_and_outstanding", "diluted_weighted_average_shares_class_a_as_converted",
      "weighted_average_shares_basic_and_diluted",
    ],
    related: /diluted.*shares|shares.*diluted/,
    synonyms: ["diluted shares", "diluted share count", "weighted average diluted shares"],
    definition: "Weighted-average diluted shares used for diluted EPS. Actual shares, split-adjusted.",
  },
  {
    id: "basic_shares",
    label: "Basic weighted-average shares",
    kind: "shares",
    blocks: [IS, "per_share", "share_data"],
    aliases: [
      "basic_shares", "weighted_average_shares_basic", "basic_weighted_average_shares",
      "weighted_average_basic_shares", "basic_weighted_average_shares_outstanding",
      "shares_basic_weighted_average", "basic_average_shares", "average_basic_common_shares",
      "basic_weighted_average_shares_class_a", "weighted_average_shares_basic_and_diluted",
    ],
    related: /basic.*shares|shares.*basic/,
    synonyms: ["basic shares", "weighted average shares", "basic share count"],
    definition: "Weighted-average basic shares. Actual shares, split-adjusted.",
  },
  {
    id: "depreciation_and_amortization",
    label: "Depreciation and amortization",
    kind: "money",
    blocks: [CF, IS],
    aliases: [
      "depreciation_and_amortization", "depreciation_amortization_and_depletion",
      "depreciation_depletion_and_amortization", "depreciation_amortization_and_accretion",
      "depreciation_and_amortization_expense", "depreciation_amortization_and_other", "depreciation_and_amortization_net",
      "depreciation", "operating_activities.depreciation_and_amortization",
    ],
    related: /depreciation|amortization|depletion/,
    exclude: /accumulated/,
    synonyms: ["d&a", "depreciation", "amortization", "depreciation and amortization"],
    definition: "Depreciation and amortization, normally from the cash flow statement.",
  },

  // ---- Balance sheet ------------------------------------------------------
  {
    id: "cash",
    label: "Cash and cash equivalents",
    kind: "money",
    blocks: [BS],
    aliases: [
      "cash_and_cash_equivalents", "cash_and_equivalents", "cash_and_due_from_banks", "cash",
      "total_cash_and_cash_equivalents", "cash_cash_equivalents_and_restricted_cash", "cash_including_restricted_cash",
      "cash_and_cash_equivalents_and_restricted_cash",
    ],
    related: /^cash|marketable|short_term_investments|^investments$|restricted_cash|deposits_with_banks/,
    exclude: /segregated|held_by|liabilit|pct/,
    synonyms: ["cash", "cash and equivalents", "cash and cash equivalents", "liquidity", "cash balance"],
    definition:
      "Cash and cash equivalents at the period end. Marketable securities and short-term investments, which many companies count as liquidity, are shown under related.",
  },
  {
    id: "total_assets",
    label: "Total assets",
    kind: "money",
    blocks: [BS],
    aliases: ["total_assets", "assets.total_assets"],
    synonyms: ["total assets", "assets"],
    definition: "Total assets at the period end.",
  },
  {
    id: "total_liabilities",
    label: "Total liabilities",
    kind: "money",
    blocks: [BS],
    aliases: ["total_liabilities", "liabilities.total_liabilities"],
    related: /^total_.*liabilities$/,
    exclude: /and_(stockholders|shareholders)|equity/,
    synonyms: ["total liabilities", "liabilities"],
    definition: "Total liabilities at the period end.",
  },
  {
    id: "total_debt",
    label: "Total debt",
    kind: "money",
    blocks: [BS],
    aliases: [
      "total_debt", "total_borrowings", "total_debt_carrying_value", "total_debt_obligations",
      "total_debt_net_carrying_amount", "total_debt_derived", "total_debt_commercial_paper_plus_term_debt",
      "total_borrowings_short_term_debt_plus_all_long_term_debt", "borrowings",
      "debt_summary.total_notes_payable_and_other_borrowings",
    ],
    related: /debt|borrowing|commercial_paper|notes_payable/,
    exclude: /ratio|to_|securities|investments|net_cash/,
    synonyms: ["debt", "total debt", "borrowings", "leverage"],
    definition:
      "Total debt at the period end. Long-term debt, short-term borrowings and the current portion are shown under related. Lease liabilities are not debt here unless the company counts them.",
  },
  {
    id: "long_term_debt",
    label: "Long-term debt",
    kind: "money",
    blocks: [BS],
    aliases: [
      "long_term_debt", "long_term_debt_less_current_portion", "long_term_debt_net_of_current_portion",
      "long_term_borrowings", "debt_noncurrent", "term_debt_non_current", "long_term_debt_noncurrent",
      "notes_payable_and_other_borrowings_non_current", "unsecured_long_term_borrowings",
    ],
    synonyms: ["long-term debt", "long term debt", "noncurrent debt"],
    definition: "Long-term debt, excluding the current portion where the company separates it.",
  },
  {
    id: "short_term_debt",
    label: "Short-term debt and current portion",
    kind: "money",
    blocks: [BS],
    aliases: [
      "short_term_debt", "short_term_borrowings", "short_term_borrowings_and_current_maturities_of_long_term_debt",
      "current_portion_of_long_term_debt", "current_maturities_of_long_term_debt", "long_term_debt_due_within_one_year",
      "debt_current", "debt_due_within_one_year", "current_maturities_of_debt", "debt_maturing_within_one_year",
      "term_debt_current", "short_term_debt_and_current_portion_of_long_term_debt", "current_portion_of_long_term_debt_net",
      "short_term_debt_obligations", "notes_payable_and_other_borrowings_current", "unsecured_short_term_borrowings",
      "commercial_paper",
    ],
    related: /short_term_(debt|borrowing)|current_(portion|maturities)|due_within_one_year|commercial_paper|debt_current/,
    synonyms: ["short-term debt", "short term debt", "current debt", "current portion of long-term debt"],
    definition: "Debt due within a year: short-term borrowings and the current portion of long-term debt.",
  },
  {
    id: "shareholders_equity",
    label: "Shareholders' equity",
    kind: "money",
    blocks: [BS],
    aliases: [
      "total_stockholders_equity", "total_shareholders_equity", "stockholders_equity", "shareholders_equity",
      "shareholders_equity.berkshire_shareholders_equity",
    ],
    lastResort: [
      "total_common_shareholders_equity", "common_stockholders_equity", "common_shareholders_equity",
      "total_equity", "shareholders_equity.total_shareholders_equity",
    ],
    patterns: [/^total_[a-z_]+_(stockholders|shareholders)_(equity|deficit)$/, /^total_(stockholders|shareholders)_equity_(attributable_to|of)_/],
    related: /equity|noncontrolling|deficit$/,
    exclude: /liabilities_and|liabilities_temporary|method|securities|investments|tangible|non_gaap/,
    synonyms: ["equity", "shareholders equity", "stockholders equity", "book value", "net worth"],
    definition:
      "Equity attributable to the company's shareholders. Total equity including noncontrolling interests is shown under related where the record carries both.",
  },
  {
    id: "current_assets",
    label: "Total current assets",
    kind: "money",
    blocks: [BS],
    aliases: ["total_current_assets", "current_assets"],
    synonyms: ["current assets"],
    definition: "Assets expected to be realized within a year.",
  },
  {
    id: "current_liabilities",
    label: "Total current liabilities",
    kind: "money",
    blocks: [BS],
    aliases: ["total_current_liabilities", "current_liabilities"],
    synonyms: ["current liabilities"],
    definition: "Liabilities due within a year.",
  },
  {
    id: "goodwill",
    label: "Goodwill",
    kind: "money",
    blocks: [BS],
    aliases: ["goodwill", "goodwill_net"],
    related: /goodwill/,
    synonyms: ["goodwill"],
    definition: "Goodwill from acquisitions.",
  },
  {
    id: "intangible_assets",
    label: "Intangible assets",
    kind: "money",
    blocks: [BS],
    aliases: [
      "intangible_assets_net", "other_intangible_assets_net", "other_intangible_assets", "other_intangibles_net",
      "acquired_intangible_assets_net", "intangible_assets", "purchased_intangible_assets_net", "intangibles_net",
      "identifiable_intangible_assets", "acquisition_related_intangibles_net", "intangible_assets_net_non_current",
      "purchased_technology_and_other_intangibles_net",
    ],
    related: /intangible/,
    synonyms: ["intangibles", "intangible assets"],
    definition: "Intangible assets other than goodwill, net of amortization.",
  },
  {
    id: "inventories",
    label: "Inventories",
    kind: "money",
    blocks: [BS],
    aliases: ["inventories", "inventory", "total_inventories", "inventories_net", "merchandise_inventories", "merchandise_inventory_net", "inventory_net"],
    related: /inventor/,
    synonyms: ["inventory", "inventories", "stock"],
    definition: "Inventories at the period end.",
  },
  {
    id: "accounts_receivable",
    label: "Accounts receivable",
    kind: "money",
    blocks: [BS],
    aliases: [
      "accounts_receivable_net", "accounts_receivable", "receivables_net", "trade_receivables_net",
      "trade_accounts_receivable_net", "accounts_and_notes_receivable_net", "receivables",
      "accounts_receivable_net_and_other", "receivables_trade_and_other_current", "trade_accounts_and_notes_receivable_net",
    ],
    related: /receivable/,
    synonyms: ["receivables", "accounts receivable", "trade receivables"],
    definition: "Amounts owed by customers, net of allowances.",
  },
  {
    id: "accounts_payable",
    label: "Accounts payable",
    kind: "money",
    blocks: [BS],
    aliases: [
      "accounts_payable", "trade_accounts_payable", "accounts_payable_trade", "trade_payables",
      "accounts_payable_and_accrued_liabilities", "accounts_payable_and_accrued_expenses",
    ],
    related: /payable/,
    exclude: /tax|dividend/,
    synonyms: ["payables", "accounts payable", "trade payables"],
    definition: "Amounts owed to suppliers.",
  },
  {
    id: "property_and_equipment",
    label: "Property, plant and equipment, net",
    kind: "money",
    blocks: [BS],
    aliases: [
      "property_plant_and_equipment_net", "property_and_equipment_net", "net_property_and_equipment",
      "net_property_plant_and_equipment", "net_properties_plants_and_equipment", "properties_plant_and_equipment_net",
      "property_plant_and_equipment", "premises_and_equipment_net", "premises_and_equipment",
    ],
    related: /property|plant|equipment/,
    exclude: /accrued/,
    synonyms: ["pp&e", "ppe", "property plant and equipment", "fixed assets"],
    definition: "Property, plant and equipment net of accumulated depreciation.",
  },
  {
    id: "retained_earnings",
    label: "Retained earnings",
    kind: "money",
    blocks: [BS],
    aliases: ["retained_earnings", "retained_earnings_accumulated_deficit", "accumulated_deficit", "retained_deficit", "retained_income"],
    synonyms: ["retained earnings", "accumulated deficit"],
    definition: "Cumulative earnings retained in the business (negative as an accumulated deficit).",
  },
  {
    id: "shares_outstanding",
    label: "Shares outstanding",
    kind: "shares",
    blocks: [BS, ".", "per_share", "share_data"],
    aliases: [
      "shares_outstanding", "common_shares_outstanding", "shares_outstanding_at_period_end",
      "shares_issued_and_outstanding", "common_shares_issued_and_outstanding", "ordinary_shares_outstanding",
      "shares_issued_and_outstanding_at_period_end", "shares_outstanding_cover_page", "shares_outstanding_on_cover",
      "common_shares_outstanding_end_of_period",
    ],
    related: /shares_outstanding|outstanding_shares|treasury_shares/,
    synonyms: ["shares outstanding", "share count", "outstanding shares"],
    definition: "Shares outstanding at the period end. Actual shares, split-adjusted.",
  },

  // ---- Cash flow ----------------------------------------------------------
  {
    id: "operating_cash_flow",
    label: "Operating cash flow",
    kind: "money",
    blocks: [CF, "."],
    aliases: [
      "operating_cash_flow", "net_cash_provided_by_operating_activities", "net_cash_provided_by_used_in_operating_activities",
      "net_cash_from_operating_activities", "cash_generated_by_operating_activities",
      "net_cash_provided_by_operating_activities_total", "net_cash_provided_by_used_for_operating_activities",
      "net_cash_from_operations", "cash_flows_from_operating_activities", "net_cash_flows_from_operating_activities",
      "operating_activities.net_cash_flows_from_operating_activities", "operating_cash_flow_for_the_quarter",
    ],
    headline: /^(operating cash flow|cash from operations)$/i,
    related: /operating_activities|operating_cash_flow|from_operations/,
    exclude: /other_operating/,
    synonyms: ["operating cash flow", "cash from operations", "cfo", "ocf", "cash flow from operations"],
    definition: "Net cash provided by operating activities.",
  },
  {
    id: "capital_expenditures",
    label: "Capital expenditures",
    kind: "money",
    blocks: [CF, "."],
    aliases: [
      "capex", "capital_expenditures", "purchases_of_property_and_equipment", "purchases_of_property_plant_and_equipment",
      "additions_to_property_and_equipment", "additions_to_property_plant_and_equipment",
      "payments_for_property_and_equipment", "payments_for_acquisition_of_property_plant_and_equipment",
      "capital_expenditures_on_premises_equipment_and_capitalized_software",
      "purchases_of_property_leasehold_improvements_and_equipment", "capital_expenditures_derived",
      "derived.capital_expenditures", "capital_expenditures_for_the_quarter",
    ],
    related: /capex|capital_expend|purchases_of_property|additions_to_property/,
    synonyms: ["capex", "capital expenditures", "capital spending", "purchases of property and equipment"],
    definition: "Cash spent on property, plant and equipment.",
    caveat:
      "Most records store capital expenditures as a positive outflow; some store the signed cash-flow value. Read the sign as recorded.",
  },
  {
    id: "free_cash_flow",
    label: "Free cash flow",
    kind: "money",
    blocks: [CF, "."],
    aliases: ["free_cash_flow", "free_cash_flow_for_the_quarter", "company_reported_free_cash_flow", "free_cash_flow_derived"],
    headline: /^free cash flow$/i,
    related: /free_cash_flow/,
    synonyms: ["free cash flow", "fcf"],
    definition:
      "Free cash flow: operating cash flow less capital expenditures. Calculated in the record from the two filed figures unless the company reports its own, so it has no sec.gov line of its own.",
  },
  {
    id: "investing_cash_flow",
    label: "Net cash from investing activities",
    kind: "money",
    blocks: [CF],
    aliases: [
      "investing_cash_flow", "net_cash_used_in_investing_activities", "net_cash_from_investing_activities",
      "net_cash_provided_by_used_in_investing_activities", "net_cash_used_for_investing_activities",
      "cash_used_in_investing_activities", "net_cash_provided_by_used_for_investing_activities",
      "net_cash_provided_by_investing_activities", "net_cash_used_in_investing", "net_cash_flows_from_investing_activities",
      "cash_provided_by_used_in_investing_activities", "investing_activities.net_cash_flows_from_investing_activities",
    ],
    synonyms: ["investing cash flow", "cash from investing", "cfi"],
    definition: "Net cash provided by (used in) investing activities.",
  },
  {
    id: "financing_cash_flow",
    label: "Net cash from financing activities",
    kind: "money",
    blocks: [CF],
    aliases: [
      "financing_cash_flow", "net_cash_used_in_financing_activities", "net_cash_provided_by_used_in_financing_activities",
      "net_cash_from_financing_activities", "net_cash_provided_by_financing_activities",
      "net_cash_provided_by_used_for_financing_activities", "cash_used_in_financing_activities",
      "net_cash_used_in_financing", "net_cash_used_for_financing_activities", "net_cash_flows_from_financing_activities",
      "cash_provided_by_used_in_financing_activities", "financing_activities.net_cash_flows_from_financing_activities",
    ],
    synonyms: ["financing cash flow", "cash from financing", "cff"],
    definition: "Net cash provided by (used in) financing activities.",
  },
  {
    id: "dividends_paid",
    label: "Dividends paid",
    kind: "money",
    blocks: [CF, "shareholder_returns", "capital_returns", "capital_returned", "dividends"],
    aliases: [
      "dividends_paid", "cash_dividends_paid", "dividends_paid_on_common_stock", "common_stock_dividends_paid",
      "dividends_and_dividend_equivalents_paid", "dividends_paid_to_common_stockholders", "dividends_paid_to_stockholders",
      "common_stock_cash_dividends_paid", "dividends_paid_to_common_shareholders", "payments_for_dividends_and_dividend_equivalents",
      "dividend_payments", "payments_of_dividends",
    ],
    related: /dividend/,
    exclude: /per_share|payable|declared_per/,
    synonyms: ["dividends", "dividends paid", "cash dividends"],
    definition: "Cash dividends paid to shareholders in the period.",
  },
  {
    id: "dividends_per_share",
    label: "Dividends per share",
    kind: "per_share",
    blocks: [CF, IS, "per_share", "dividends", "shareholder_returns", "share_data", "."],
    aliases: [
      "dividends_per_share", "dividends_declared_per_share", "cash_dividends_declared_per_share",
      "dividends_declared_per_common_share", "dividends_paid_per_share", "dividends_declared_and_paid_per_share",
    ],
    related: /dividend.*per_share|per_share.*dividend/,
    synonyms: ["dividend per share", "dividends per share", "dps", "dividend"],
    definition: "Dividends declared or paid per share, as the record states which.",
  },
  {
    id: "share_repurchases",
    label: "Share repurchases",
    kind: "money",
    blocks: [CF, "shareholder_returns", "capital_returns", "capital_returned"],
    aliases: [
      "share_repurchases", "repurchases_of_common_stock", "repurchase_of_common_stock", "purchases_of_treasury_stock",
      "common_stock_repurchased", "treasury_stock_purchases", "purchase_of_treasury_stock", "repurchase_of_ordinary_shares",
      "payments_for_repurchase_of_common_stock", "purchases_of_common_stock_for_treasury", "treasury_stock_acquired",
      "net_purchases_of_treasury_shares", "repurchases_of_common_stock_repurchase_program", "share_repurchases_repurchase_program",
    ],
    related: /repurchase|buyback|treasury/,
    exclude: /debt/,
    synonyms: ["buybacks", "share repurchases", "stock buybacks", "repurchases"],
    definition: "Cash spent buying back the company's own shares.",
  },
  {
    id: "stock_based_compensation",
    label: "Stock-based compensation",
    kind: "money",
    blocks: [CF, IS, "."],
    aliases: [
      "stock_based_compensation", "share_based_compensation", "stock_based_compensation_expense",
      "share_based_compensation_expense", "equity_based_compensation", "stock_compensation_cost",
    ],
    related: /stock_based|share_based|equity_based|stock_compensation/,
    synonyms: ["sbc", "stock-based compensation", "share-based compensation", "stock comp"],
    definition: "Non-cash stock-based compensation expense, normally from the cash flow statement.",
  },
  {
    id: "acquisitions",
    label: "Acquisitions, net of cash acquired",
    kind: "money",
    blocks: [CF],
    aliases: [
      "acquisitions_net_of_cash_acquired", "acquisitions_of_businesses_net_of_cash_acquired",
      "acquisition_of_businesses_net_of_cash_acquired", "business_combinations_net_of_cash_acquired",
      "purchases_of_businesses_net_of_cash_acquired", "business_acquisitions_net_of_cash_acquired",
      "payments_for_business_acquisitions_net_of_cash_acquired", "acquisitions",
    ],
    related: /acqui/,
    exclude: /property|intangible/,
    synonyms: ["acquisitions", "m&a spending", "cash paid for acquisitions"],
    definition: "Cash paid for acquisitions of businesses, net of the cash they held.",
  },
];

const BY_ID = new Map(FIGURES.map((f) => [f.id, f]));

export function figureById(id: string): FigureDef | undefined {
  return BY_ID.get(id);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9&%]+/g, " ").trim();
}

/** A standard figure by its id, label, a synonym, or one of its field names. */
export function findStandardFigure(input: string): FigureDef | undefined {
  const q = norm(input);
  if (!q) return undefined;
  const qid = q.replace(/ /g, "_");
  return (
    BY_ID.get(qid) ??
    FIGURES.find((f) => norm(f.label) === q) ??
    FIGURES.find((f) => f.synonyms.some((s) => norm(s) === q)) ??
    FIGURES.find((f) => f.aliases.includes(qid))
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface FieldValue {
  field: string;
  value: number;
}

export interface Resolution {
  primary: FieldValue | null;
  related: FieldValue[];
  /** How the primary was chosen. */
  matched_by?: "company headline field" | "standard field name" | "unique name pattern";
}

function blockOf(p: Period, block: string): Record<string, unknown> | null {
  if (block === ".") return p.data;
  const v = p.data[block];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Read "revenues.total_revenues" inside a block. Names never contain dots, so dots are paths. */
function readIn(b: Record<string, unknown> | null, key: string): unknown {
  let node: unknown = b;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function fieldName(block: string, key: string): string {
  return block === "." ? key : `${block}.${key}`;
}

/** The field the company's own headline uses for this figure, e.g. "income_statement.net_earnings". */
export function headlineField(doc: FinancialsDoc, def: FigureDef): string | null {
  if (!def.headline) return null;
  const h = doc.headline as { metrics?: { label?: string; source?: { field?: string } }[] } | undefined;
  for (const m of h?.metrics ?? []) {
    if (m.label && def.headline.test(m.label.trim()) && m.source?.field) return m.source.field;
  }
  return null;
}

export function resolveFigure(p: Period, def: FigureDef, headline: string | null): Resolution {
  let primary: FieldValue | null = null;
  let matched_by: Resolution["matched_by"];

  const tryNames = (names: string[], how: Resolution["matched_by"]) => {
    for (const name of names) {
      for (const block of def.blocks) {
        const v = readIn(blockOf(p, block), name);
        if (isNum(v)) {
          primary = { field: fieldName(block, name), value: v };
          matched_by = how;
          return;
        }
      }
    }
  };

  if (headline) {
    // The headline names a full path from the period: "income_statement.revenues.total_revenues".
    const v = readIn(p.data, headline);
    if (isNum(v)) {
      primary = { field: headline, value: v };
      matched_by = "company headline field";
    }
  }
  if (!primary) tryNames(def.aliases, "standard field name");
  if (!primary && def.patterns) {
    outer: for (const block of def.blocks) {
      const b = blockOf(p, block);
      if (!b) continue;
      for (const re of def.patterns) {
        const keys = Object.keys(b).filter((k) => re.test(k) && isNum(b[k]));
        if (keys.length === 1) {
          primary = { field: fieldName(block, keys[0]), value: b[keys[0]] as number };
          matched_by = "unique name pattern";
          break outer;
        }
      }
    }
  }
  if (!primary && def.lastResort) tryNames(def.lastResort, "standard field name");

  const related: FieldValue[] = [];
  const chosen = (primary as FieldValue | null)?.field;
  if (def.related) {
    for (const block of def.blocks) {
      if (block === ".") continue;
      const b = blockOf(p, block);
      if (!b) continue;
      for (const [k, v] of Object.entries(b)) {
        if (!def.related.test(k) || (def.exclude && def.exclude.test(k))) continue;
        if (isNum(v)) {
          const f = fieldName(block, k);
          if (f !== chosen) related.push({ field: f, value: v });
        } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          // A nested breakdown named like the figure ("revenue": {automotive, ..., total}).
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
            const f = `${fieldName(block, k)}.${k2}`;
            if (isNum(v2) && f !== chosen) related.push({ field: f, value: v2 });
          }
        }
      }
    }
  }
  return { primary, related: related.slice(0, 12), matched_by };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function currencyPrefix(doc: FinancialsDoc): string {
  const cur = String(doc.reporting_currency ?? "USD").toUpperCase();
  return cur === "USD" || doc.converted_to_usd === true ? "$" : `${cur} `;
}

function scaled(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(a / 1e12).toFixed(2)} trillion`;
  if (a >= 1e9) return `${(a / 1e9).toFixed(2)} billion`;
  if (a >= 1e6) return `${(a / 1e6).toFixed(2)} million`;
  return a.toLocaleString("en-US");
}

export function display(value: number, kind: FigureKind, prefix = "$"): string {
  const sign = value < 0 ? "-" : "";
  switch (kind) {
    case "money":
      return `${sign}${prefix}${scaled(value)} (${sign}${prefix}${Math.abs(value).toLocaleString("en-US")})`;
    case "per_share":
      return `${sign}${prefix}${Math.abs(value).toFixed(2)}`;
    case "shares":
      return `${sign}${scaled(value)} shares`;
    case "percent":
      return `${value}%`;
  }
}

// ---------------------------------------------------------------------------
// Figure source links
// ---------------------------------------------------------------------------

/**
 * The sec.gov link that opens the filing at the line printing this figure, from the
 * record's figure_sources block. It mirrors the figures' paths: the entry for
 * quarterly[0].income_statement.revenue is figure_sources.quarterly[0].income_statement.revenue,
 * which reads "d2#f-30", and the link is figure_sources.documents.d2 + "#f-30".
 * Returns null for a figure with no entry (calculated, or from an untagged release).
 */
export function figureLink(doc: FinancialsDoc, p: Period, fieldPath: string): string | null {
  const fs = doc.figure_sources as Record<string, unknown> | undefined;
  if (!fs) return null;
  const docs = fs.documents as Record<string, string> | undefined;
  let node: unknown = fs[p.array];
  if (Array.isArray(node)) {
    let entry = p.index !== null ? node[p.index] : undefined;
    const pe = (entry as Record<string, unknown> | undefined)?.period_end;
    if (pe && p.period_end && pe !== p.period_end) {
      entry = node.find((e) => (e as Record<string, unknown>)?.period_end === p.period_end);
    }
    node = entry;
  }
  for (const part of splitPath(fieldPath)) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") return null;
  const hash = node.indexOf("#");
  if (hash < 0 || !docs) return null;
  const base = docs[node.slice(0, hash)];
  return base ? `${base}${node.slice(hash)}` : null;
}

/** Split "reportable_segments.Compute & Networking.revenue" on dots, but only between keys. */
export function splitPath(path: string): string[] {
  return path.split(".");
}

// ---------------------------------------------------------------------------
// Every figure a record holds
// ---------------------------------------------------------------------------

export interface FlatFigure {
  path: string;
  block: string;
  value: number;
}

/** Every numeric figure in a period, as dotted paths, nested blocks included. */
export function flattenPeriod(p: Period, maxDepth = 4): FlatFigure[] {
  const out: FlatFigure[] = [];
  const walk = (node: unknown, path: string[], block: string, depth: number) => {
    if (isNum(node)) {
      out.push({ path: path.join("."), block, value: node });
      return;
    }
    if (depth >= maxDepth || typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, [...path, k], block, depth + 1);
  };
  for (const [k, v] of Object.entries(p.data)) {
    if (k === "conversion") continue;
    if (isNum(v)) out.push({ path: k, block: ".", value: v });
    else walk(v, [k], k, 1);
  }
  return out;
}

/** Read a dotted path inside a period. */
export function readPath(p: Period, path: string): number | null {
  let node: unknown = p.data;
  for (const part of splitPath(path)) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return isNum(node) ? node : null;
}

/** The record's own name for a field: the last key of its path ("total_net_sales"). */
export function nameOf(field: string): string {
  return field.split(".").at(-1) ?? field;
}

/** Names compare without case, spacing or punctuation: "Data Center" = "data_center". */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Shared envelope for a figure across periods: what was found, where, and what was not. */
export function figureRows(
  doc: FinancialsDoc,
  periods: Period[],
  def: FigureDef,
  docsByRecord: Map<string, FinancialsDoc>,
): { values: Record<string, unknown>[]; missing: Record<string, unknown>[] } {
  const values: Record<string, unknown>[] = [];
  const missing: Record<string, unknown>[] = [];
  for (const p of periods) {
    const d = docsByRecord.get(p.record) ?? doc;
    const r = resolveFigure(p, def, headlineField(d, def));
    const head = periodHeader(p);
    const base = {
      period: head.period,
      kind: p.kind,
      period_start: p.period_start,
      period_end: p.period_end,
    };
    if (r.primary) {
      // The record's own name for the figure leads the row. The standard id only
      // says which question it answers; the name is what the JSON and the site use.
      const row: Record<string, unknown> = {
        name_in_record: nameOf(r.primary.field),
        field: r.primary.field,
        json_path: `${periodPath(p)}.${r.primary.field}`,
        ...base,
        value: r.primary.value,
        display: display(r.primary.value, def.kind, currencyPrefix(d)),
        matched_by: r.matched_by,
        source_accession: head.source_accession ?? null,
      };
      if (head.source_form) row.source_form = head.source_form;
      const link = figureLink(d, p, r.primary.field);
      row.sec_link = link ?? "none: calculated in the record, or from an untagged earnings release";
      if (r.related.length) row.related = Object.fromEntries(r.related.map((x) => [x.field, x.value]));
      if (p.record !== periods[0]?.record || docsByRecord.size > 1) row.record = p.record;
      values.push(row);
    } else {
      missing.push({
        ...base,
        reason: `No field in this period matches ${def.label.toLowerCase()} under the names it answers to.`,
        ...(r.related.length ? { similar_fields: Object.fromEntries(r.related.map((x) => [x.field, x.value])) } : {}),
      });
    }
  }
  return { values, missing };
}
