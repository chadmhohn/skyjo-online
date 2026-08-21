import SwiftUI

@MainActor
struct AuthenticationView: View {
  @Bindable var model: AppModel
  @Bindable private var authentication: AuthenticationFormModel
  private let embedsNavigation: Bool

  init(model: AppModel, embedsNavigation: Bool = true) {
    self.model = model
    _authentication = Bindable(model.authentication)
    self.embedsNavigation = embedsNavigation
  }

  var body: some View {
    Group {
      if embedsNavigation {
        NavigationStack { authenticationForm }
      } else {
        authenticationForm
      }
    }
  }

  private var authenticationForm: some View {
    Form {
        Section {
          Picker("Account action", selection: $authentication.mode) {
            ForEach(AuthenticationMode.allCases) { mode in
              Text(mode.rawValue).tag(mode)
            }
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("auth.mode")
          .onChange(of: model.authentication.mode) {
            model.authentication.errorMessage = ""
            model.authentication.clearSensitiveFields()
          }
        }

        Section(model.authentication.mode.rawValue) {
          TextField("Email", text: $authentication.email)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("auth.email")

          if model.authentication.mode == .signup {
            TextField("Display name", text: $authentication.displayName)
              .textContentType(.name)
              .accessibilityIdentifier("auth.display-name")
          }

          SecureField("Password", text: $authentication.password)
            .textContentType(model.authentication.mode == .signup ? .newPassword : .password)
            .accessibilityIdentifier("auth.password")

          if model.authentication.mode == .signup {
            SecureField("Confirm password", text: $authentication.confirmPassword)
              .textContentType(.newPassword)
              .submitLabel(.go)
              .onSubmit { submit() }
              .accessibilityIdentifier("auth.confirm-password")
          }

          Button {
            submit()
          } label: {
            HStack {
              Text(model.authentication.mode.rawValue)
              if model.authentication.isSubmitting {
                Spacer()
                ProgressView()
                  .accessibilityLabel("Submitting account request")
              }
            }
          }
          .disabled(!model.authentication.canSubmit)
          .accessibilityIdentifier("auth.submit")
        }

        if model.authentication.mode == .signup {
          Section {
            Text("Passwords must be at least 8 characters. Account sessions are kept by secure server cookies; the app does not save your password.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }

        if !model.authentication.errorMessage.isEmpty {
          Section {
            Label(model.authentication.errorMessage, systemImage: "exclamationmark.circle")
              .foregroundStyle(
                model.authentication.errorMessage.hasPrefix("Password changed")
                  ? Color.secondary
                  : Color.red
              )
              .accessibilityIdentifier("auth.error")
          }
        }
    }
    .navigationTitle("Your Account")
    .disabled(model.authentication.isSubmitting)
  }

  private func submit() {
    guard model.authentication.canSubmit else { return }
    Task { await model.submitAuthentication() }
  }
}
