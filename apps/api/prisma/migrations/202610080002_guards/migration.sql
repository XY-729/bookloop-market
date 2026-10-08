-- PostgreSQL invariants that Prisma's schema language cannot express.
ALTER TABLE "Product" ADD CONSTRAINT "product_price_positive" CHECK ("price" > 0 AND "price" <= 1000000);
ALTER TABLE "Product" ADD CONSTRAINT "different_book_photos" CHECK ("frontMediaId" <> "backMediaId");
ALTER TABLE "Order" ADD CONSTRAINT "order_money_valid" CHECK ("amount" > 0 AND "fee" >= 0 AND "fee" <= "amount");
ALTER TABLE "Refund" ADD CONSTRAINT "refund_money_positive" CHECK ("amount" > 0);
ALTER TABLE "Settlement" ADD CONSTRAINT "settlement_money_valid" CHECK ("amount" >= 0);
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_credit_nonnegative" CHECK ("remaining" >= 0);
CREATE UNIQUE INDEX "single_live_order_per_product" ON "Order"("productId")
WHERE "status" IN ('UNPAID','PAID','DELIVERED','REFUND_REQUESTED','WAIT_RETURN','REFUNDING','SETTLING','SETTLED');
CREATE UNIQUE INDEX "single_pending_verification" ON "Verification"("userId") WHERE "status"='PENDING';
