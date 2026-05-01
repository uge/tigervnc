declare module "des.js" {
  export const DES: {
    create(options: {
      type: "encrypt" | "decrypt";
      key: number[];
      padding: boolean;
    }): {
      update(input: number[]): number[];
      final(): number[];
    };
  };
}
