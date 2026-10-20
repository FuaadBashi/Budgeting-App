# Adding money updates

Select **Add** in the navigation. Simple entry is the default; the original split-payment form remains under **Advanced / split payment**.

- **Purchase:** enter the name and amount, choose the paying account and category.
- **Income:** choose the receiving account and income source.
- **Transfer:** choose the source and destination accounts. This is not spending or income.
- **Debt repayment:** choose the paying account and the liability being repaid. This does not record another purchase.
- **Refund:** select the original purchase and the receiving account. Split purchases are refunded proportionally across their original expense legs and categories. The server caps refunds, including pending refunds, at the original purchase total.
- **Balance update:** enter the actual balance (positive amount owed for a credit card). This creates a visible unexplained adjustment, not an invented purchase. Use the same pending-payment convention as the existing ledger to avoid double counting.
- **Other:** write the exact name, then explicitly choose accounts and direction. Account and category lists also offer Other to create named options. New accounts start at zero.

Check the balance preview before saving. The form checks for changed account balances again when saving and asks for another review if necessary.

## Pending payments

Choose **Pending — not in balances yet** when adding a transaction. Pending entries do not change current balances or spending and are not an automatic reservation of available cash. The preview shows the effect when posted.

To finish one, open Add → **Mark pending as paid / received**, choose the entry and settlement date, review the preview, and save. This posts the same transaction, so repeating settlement does not create a duplicate. Voided entries cannot be settled.

This action operates on candidate transactions, not scheduled expected-income plans. Legacy transactions whose descriptions say pending but whose ledger status is already posted must not be entered again.

## Checks

Backend coverage: `tests/unit/test_quick_entry.py` covers pending isolation, repeat settlement, void protection, credit-card transfer signs, and refund caps including pending refunds.
