{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
	nativeBuildInputs = [
		pkgs.git
		pkgs.nodejs-16_x
		pkgs.nodePackages.npm
	];
}
